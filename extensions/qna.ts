/**
 * Q&A extension.
 *
 * - questions tool: asks one or more interactive questions.
 * - /answers command: extracts questions from the last assistant message, then asks them.
 */

import { complete, type Api, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface QuestionInput {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionOption[];
  allowOther?: boolean;
  multiSelect?: boolean;
}

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

interface QuestionsResult {
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

const QuestionsParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});


// Structured output format for /answers extraction
interface ExtractedQuestion {
  question: string;
  context?: string;
}

interface ExtractionResult {
  questions: ExtractedQuestion[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}`;

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

async function selectExtractionModel(
  currentModel: Model<Api>,
  modelRegistry: {
    find: (provider: string, modelId: string) => Model<Api> | undefined;
    getApiKeyAndHeaders(model: Model<Api>): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  },
): Promise<Model<Api>> {
  const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
  if (codexModel) {
    const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
    if (auth.ok && auth.apiKey) {
      return codexModel;
    }
  }

  const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (!haikuModel) {
    return currentModel;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
  if (!auth.ok || !auth.apiKey) {
    return currentModel;
  }

  return haikuModel;
}

function parseExtractionResult(text: string): ExtractionResult | null {
  try {
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed && Array.isArray(parsed.questions)) {
      return parsed as ExtractionResult;
    }
    return null;
  } catch {
    return null;
  }
}

function errorResult(
  message: string,
  questions: Question[] = [],
): AgentToolResult<QuestionsResult> {
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


async function runQuestions(
  params: { questions: QuestionInput[] },
  ctx: ExtensionContext,
): Promise<AgentToolResult<QuestionsResult>> {
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

  const isMultiQuestionSet = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit

  const result = await ctx.ui.custom<QuestionsResult>((tui, theme, _kb, done) => {
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
      if (!isMultiQuestionSet) {
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
      if (isMultiQuestionSet) {
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
      if (isMultiQuestionSet) {
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
          help = isMultiQuestionSet
            ? " Tab/←→ navigate • Enter submit • Esc cancel"
            : " Enter submit • Esc cancel";
        } else if (q?.multiSelect) {
          help = isMultiQuestionSet
            ? " Tab/←→ navigate • ↑↓ move • Space toggle • Enter continue • Esc cancel"
            : " ↑↓ move • Space toggle • Enter submit • Esc cancel";
        } else {
          help = isMultiQuestionSet
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
      content: [{ type: "text", text: "User cancelled questions" }],
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
}

function answerFor(result: QuestionsResult, questionId: string): Answer | undefined {
  return result.answers.find((answer) => answer.id === questionId);
}

function answersMessage(result: QuestionsResult): string {
  const parts: string[] = [];
  for (const question of result.questions) {
    const answer = answerFor(result, question.id);
    parts.push(`Q: ${question.prompt}`);
    parts.push(`A: ${answer ? answerText(answer) : "(no answer)"}`);
    parts.push("");
  }
  return parts.join("\n").trim();
}

function extractedToQuestions(extracted: ExtractedQuestion[]): QuestionInput[] {
  return extracted.map((question, index) => {
    const prompt = question.context
      ? `${question.question} — ${question.context}`
      : question.question;
    return {
      id: `q${index + 1}`,
      label: `Q${index + 1}`,
      prompt,
      options: [],
      allowOther: true,
      multiSelect: false,
    };
  });
}

async function lastAssistantText(ctx: ExtensionContext): Promise<string | false | undefined> {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!("role" in msg) || msg.role !== "assistant") continue;

    if (msg.stopReason !== "stop") {
      ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
      return false;
    }

    const textParts = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return undefined;
}

async function extractQuestions(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<ExtractionResult | null> {
  if (!ctx.model) return null;

  const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? "No API key" : auth.error);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };

  const response = await complete(
    extractionModel,
    { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted") {
    return null;
  }

  const responseText = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return parseExtractionResult(responseText);
}

export default function qna(pi: ExtensionAPI) {
  const answersHandler = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("/answers requires interactive mode", "error");
      return;
    }

    if (!ctx.model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    const text = await lastAssistantText(ctx);
    if (text === false) {
      return;
    }
    if (!text) {
      ctx.ui.notify("No assistant messages found", "error");
      return;
    }

    const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Extracting questions...");
      loader.onAbort = () => done(null);

      extractQuestions(text, ctx, loader.signal)
        .then(done)
        .catch(() => done(null));

      return loader;
    });

    if (extractionResult === null) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    if (extractionResult.questions.length === 0) {
      ctx.ui.notify("No questions found in the last message", "info");
      return;
    }

    const result = await runQuestions(
      { questions: extractedToQuestions(extractionResult.questions) },
      ctx,
    );

    if (result.details.cancelled) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    pi.sendMessage(
      {
        customType: "answers",
        content: "I answered your questions in the following way:\n\n" + answersMessage(result.details),
        display: true,
      },
      { triggerTurn: true },
    );
  };

  pi.registerTool({
    name: "questions",
    label: "Questions",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Supports single-select, multi-select, and freeform answers.",
    promptSnippet: "Ask the user one or more interactive questions",
    promptGuidelines: [
      "Use this when you need specific input from the user before continuing.",
      "Provide clear option labels for known choices; leave options empty for freeform answers.",
    ],
    parameters: QuestionsParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runQuestions(params, ctx);
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as QuestionInput[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questions "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionsResult | undefined;
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

  pi.registerCommand("answers", {
    description: "Extract questions from the last assistant message and answer them",
    handler: (_args, ctx) => answersHandler(ctx),
  });

  pi.registerShortcut("ctrl+.", {
    description: "Extract and answer questions",
    handler: answersHandler,
  });
}
