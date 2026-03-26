/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions.
 *
 * - Single question: simple options list
 * - Multiple questions: tab bar navigation between questions
 * - Per-question multi-select: select more than one option before continuing
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
  multiSelect: boolean;
}

interface AnswerSelection {
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface Answer {
  id: string;
  selections: AnswerSelection[];
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Allow 'Type something' option (default: true)" }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: "Allow selecting more than one option before continuing (default: false)",
    }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
  message: string,
  questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

function selectionText(selection: AnswerSelection): string {
  if (selection.wasCustom) {
    return `(wrote) ${selection.label}`;
  }
  return selection.index ? `${selection.index}. ${selection.label}` : selection.label;
}

function answerText(answer: Answer): string {
  return answer.selections.map(selectionText).join("; ");
}

function answerSummary(answer: Answer): string {
  if (answer.selections.length === 1) {
    const selection = answer.selections[0];
    if (selection.wasCustom) {
      return `user wrote: ${selection.label}`;
    }
    return `user selected: ${selectionText(selection)}`;
  }
  return `user selected: ${answerText(answer)}`;
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Supports both single-select and multi-select questions.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (running in non-interactive mode)");
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
        multiSelect: q.multiSelect === true,
      }));

      const isMultiQuestionnaire = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        // State
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        // Editor for "Type something" option
        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        // Helpers
        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        function submit(cancelled: boolean) {
          const orderedAnswers = questions
            .map((question) => answers.get(question.id))
            .filter((answer): answer is Answer => answer !== undefined);
          done({ questions, answers: orderedAnswers, cancelled });
        }

        function currentQuestion(): Question | undefined {
          return questions[currentTab];
        }

        function selectionsFor(questionId: string): AnswerSelection[] {
          return answers.get(questionId)?.selections ?? [];
        }

        function customSelectionFor(questionId: string): AnswerSelection | undefined {
          return selectionsFor(questionId).find((selection) => selection.wasCustom);
        }

        function sortSelections(selections: AnswerSelection[]): AnswerSelection[] {
          return [...selections].sort((a, b) => {
            const aRank = a.wasCustom ? Number.MAX_SAFE_INTEGER : (a.index ?? Number.MAX_SAFE_INTEGER - 1);
            const bRank = b.wasCustom ? Number.MAX_SAFE_INTEGER : (b.index ?? Number.MAX_SAFE_INTEGER - 1);
            if (aRank !== bRank) return aRank - bRank;
            return a.label.localeCompare(b.label);
          });
        }

        function replaceSelections(questionId: string, selections: AnswerSelection[]) {
          if (selections.length === 0) {
            answers.delete(questionId);
            return;
          }
          answers.set(questionId, { id: questionId, selections: sortSelections(selections) });
        }

        function currentOptions(): RenderOption[] {
          const q = currentQuestion();
          if (!q) return [];

          const opts: RenderOption[] = [...q.options];
          if (q.allowOther) {
            const custom = customSelectionFor(q.id);
            opts.push({
              value: "__other__",
              label: custom ? `Custom answer: ${custom.label}` : "Type something.",
              description: q.multiSelect
                ? custom
                  ? "Enter to edit • Space to remove"
                  : "Enter to add a custom choice"
                : undefined,
              isOther: true,
            });
          }
          return opts;
        }

        function optionSelection(option: RenderOption, displayedIndex: number): AnswerSelection {
          return {
            value: option.value,
            label: option.label,
            wasCustom: false,
            index: displayedIndex,
          };
        }

        function isSelected(questionId: string, option: RenderOption, displayedIndex: number): boolean {
          const selections = selectionsFor(questionId);
          if (option.isOther) {
            return selections.some((selection) => selection.wasCustom);
          }
          return selections.some(
            (selection) => !selection.wasCustom && selection.index === displayedIndex,
          );
        }

        function allAnswered(): boolean {
          return questions.every((q) => answers.has(q.id));
        }

        function advanceAfterAnswer() {
          if (!isMultiQuestionnaire) {
            submit(false);
            return;
          }
          if (currentTab < questions.length - 1) {
            currentTab++;
          } else {
            currentTab = questions.length; // Submit tab
          }
          optionIndex = 0;
          refresh();
        }

        function saveSingleAnswer(questionId: string, selection: AnswerSelection) {
          replaceSelections(questionId, [selection]);
        }

        function toggleMultiAnswer(questionId: string, selection: AnswerSelection) {
          const currentSelections = selectionsFor(questionId);
          const nextSelections = currentSelections.some(
            (existing) =>
              !existing.wasCustom &&
              !selection.wasCustom &&
              existing.index === selection.index &&
              existing.value === selection.value,
          )
            ? currentSelections.filter(
                (existing) =>
                  existing.wasCustom ||
                  selection.wasCustom ||
                  existing.index !== selection.index ||
                  existing.value !== selection.value,
              )
            : [...currentSelections, selection];

          replaceSelections(questionId, nextSelections);
        }

        function saveCustomAnswer(questionId: string, label: string, multiSelect: boolean) {
          const customSelection: AnswerSelection = {
            value: label,
            label,
            wasCustom: true,
          };

          if (!multiSelect) {
            replaceSelections(questionId, [customSelection]);
            return;
          }

          const nextSelections = selectionsFor(questionId).filter((selection) => !selection.wasCustom);
          nextSelections.push(customSelection);
          replaceSelections(questionId, nextSelections);
        }

        function removeCustomAnswer(questionId: string) {
          const nextSelections = selectionsFor(questionId).filter((selection) => !selection.wasCustom);
          replaceSelections(questionId, nextSelections);
        }

        function startOtherInput(question: Question) {
          inputMode = true;
          inputQuestionId = question.id;
          editor.setText(customSelectionFor(question.id)?.label ?? "");
          refresh();
        }

        // Editor submit callback
        editor.onSubmit = (value) => {
          if (!inputQuestionId) return;

          const question = questions.find((candidate) => candidate.id === inputQuestionId);
          if (!question) {
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            refresh();
            return;
          }

          const trimmed = value.trim() || "(no response)";
          saveCustomAnswer(question.id, trimmed, question.multiSelect);
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");

          if (question.multiSelect) {
            refresh();
            return;
          }

          advanceAfterAnswer();
        };

        function handleInput(data: string) {
          // Input mode: route to editor
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();

          // Tab navigation (multi-question only)
          if (isMultiQuestionnaire) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }

          // Submit tab
          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) {
              submit(false);
            } else if (matchesKey(data, Key.escape)) {
              submit(true);
            }
            return;
          }

          // Option navigation
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            const maxOptionIndex = Math.max(0, opts.length - 1);
            optionIndex = Math.min(maxOptionIndex, optionIndex + 1);
            refresh();
            return;
          }

          if (!q) {
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
            return;
          }

          const opt = opts[optionIndex];
          if (!opt) {
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
            return;
          }

          // Toggle option for multi-select questions
          if (q.multiSelect && matchesKey(data, Key.space)) {
            if (opt.isOther) {
              if (customSelectionFor(q.id)) {
                removeCustomAnswer(q.id);
                refresh();
              } else {
                startOtherInput(q);
              }
              return;
            }

            toggleMultiAnswer(q.id, optionSelection(opt, optionIndex + 1));
            refresh();
            return;
          }

          // Confirm / continue
          if (matchesKey(data, Key.enter)) {
            if (opt.isOther) {
              startOtherInput(q);
              return;
            }

            if (q.multiSelect) {
              if (answers.has(q.id)) {
                advanceAfterAnswer();
              } else {
                refresh();
              }
              return;
            }

            saveSingleAnswer(q.id, optionSelection(opt, optionIndex + 1));
            advanceAfterAnswer();
            return;
          }

          // Cancel
          if (matchesKey(data, Key.escape)) {
            submit(true);
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const q = currentQuestion();
          const opts = currentOptions();

          // Helper to add truncated line
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          add(theme.fg("accent", "─".repeat(width)));

          // Tab bar (multi-question only)
          if (isMultiQuestionnaire) {
            const tabs: string[] = ["← "];
            for (let i = 0; i < questions.length; i++) {
              const isActive = i === currentTab;
              const isAnswered = answers.has(questions[i].id);
              const lbl = questions[i].label;
              const box = isAnswered ? "■" : "□";
              const color = isAnswered ? "success" : "muted";
              const text = ` ${box} ${lbl} `;
              const styled = isActive
                ? theme.bg("selectedBg", theme.fg("text", text))
                : theme.fg(color, text);
              tabs.push(`${styled} `);
            }
            const canSubmit = allAnswered();
            const isSubmitTab = currentTab === questions.length;
            const submitText = " ✓ Submit ";
            const submitStyled = isSubmitTab
              ? theme.bg("selectedBg", theme.fg("text", submitText))
              : theme.fg(canSubmit ? "success" : "dim", submitText);
            tabs.push(`${submitStyled} →`);
            add(` ${tabs.join("")}`);
            lines.push("");
          }

          // Helper to render options list
          function renderOptions() {
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i];
              const selected = i === optionIndex;
              const selectedPrefix = selected ? theme.fg("accent", "> ") : "  ";
              const checked = q?.multiSelect ? isSelected(q.id, opt, i + 1) : false;
              const checkbox = q?.multiSelect ? `[${checked ? "x" : " "}] ` : "";
              const color = selected ? "accent" : checked ? "success" : "text";
              const suffix = opt.isOther && inputMode ? " ✎" : "";
              add(selectedPrefix + theme.fg(color, `${checkbox}${i + 1}. ${opt.label}${suffix}`));
              if (opt.description) {
                add(`     ${theme.fg("muted", opt.description)}`);
              }
            }
          }

          // Content
          if (inputMode && q) {
            add(theme.fg("text", ` ${q.prompt}`));
            lines.push("");
            renderOptions();
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) {
              add(` ${line}`);
            }
            lines.push("");
            add(
              theme.fg(
                "dim",
                q.multiSelect
                  ? " Enter to save custom choice • Esc to cancel"
                  : " Enter to submit • Esc to cancel",
              ),
            );
          } else if (currentTab === questions.length) {
            add(theme.fg("accent", theme.bold(" Ready to submit")));
            lines.push("");
            for (const question of questions) {
              const answer = answers.get(question.id);
              if (answer) {
                add(
                  `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", answerText(answer))}`,
                );
              }
            }
            lines.push("");
            if (allAnswered()) {
              add(theme.fg("success", " Press Enter to submit"));
            } else {
              const missing = questions
                .filter((question) => !answers.has(question.id))
                .map((question) => question.label)
                .join(", ");
              add(theme.fg("warning", ` Unanswered: ${missing}`));
            }
          } else if (q) {
            add(theme.fg("text", ` ${q.prompt}`));
            if (q.multiSelect) {
              lines.push("");
              add(theme.fg("muted", " Select one or more choices."));
            }
            lines.push("");
            renderOptions();
          }

          lines.push("");
          if (!inputMode) {
            let help = " Esc cancel";
            if (currentTab === questions.length) {
              help = isMultiQuestionnaire
                ? " Tab/←→ navigate • Enter submit • Esc cancel"
                : " Enter submit • Esc cancel";
            } else if (q?.multiSelect) {
              help = isMultiQuestionnaire
                ? " Tab/←→ navigate • ↑↓ move • Space toggle • Enter continue • Esc cancel"
                : " ↑↓ move • Space toggle • Enter submit • Esc cancel";
            } else {
              help = isMultiQuestionnaire
                ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
                : " ↑↓ navigate • Enter select • Esc cancel";
            }
            add(theme.fg("dim", help));
          }
          add(theme.fg("accent", "─".repeat(width)));

          cachedLines = lines;
          return lines;
        }

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
        };
      });

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((answer) => {
        const qLabel = questions.find((q) => q.id === answer.id)?.label || answer.id;
        return `${qLabel}: ${answerSummary(answer)}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((answer) => {
        const selections = answer.selections
          .map((selection) => {
            if (selection.wasCustom) {
              return `${theme.fg("muted", "(wrote) ")}${selection.label}`;
            }
            return selection.index ? `${selection.index}. ${selection.label}` : selection.label;
          })
          .join(theme.fg("dim", ", "));
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${selections}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
