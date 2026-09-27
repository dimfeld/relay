export interface ActivityCommandSubmission {
  text: string;
  submissionId: string;
}

export interface ActivityCommandFormState {
  text: string;
  testMode: boolean;
  pending: boolean;
  eventId: string | null;
  preview: import("./server/events/preview").WebCommandPreview | null;
  error: string | null;
  submission: { id: string; text: string } | null;
}

export function createActivityCommandFormState(): ActivityCommandFormState {
  return {
    text: "",
    testMode: false,
    pending: false,
    eventId: null,
    preview: null,
    error: null,
    submission: null,
  };
}

export async function submitActivityCommandForm(
  state: ActivityCommandFormState,
  submit: (input: ActivityCommandSubmission) => Promise<string>,
  refresh: () => Promise<unknown>,
  preview?: (input: {
    text: string;
  }) => Promise<import("./server/events/preview").WebCommandPreview>
): Promise<void> {
  if (state.pending || !state.text.trim()) return;

  const text = state.text;
  if (state.submission?.text !== text) {
    state.submission = { id: crypto.randomUUID(), text };
  }
  state.pending = true;
  state.error = null;
  state.eventId = null;
  state.preview = null;

  if (state.testMode) {
    try {
      if (!preview) throw new Error("Test mode is unavailable.");
      state.preview = await preview({ text });
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      state.pending = false;
    }
    return;
  }

  let eventId: string;
  try {
    eventId = await submit({ text, submissionId: state.submission.id });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
    state.pending = false;
    return;
  }

  state.eventId = eventId;
  state.text = "";
  state.submission = null;
  state.pending = false;

  try {
    await refresh();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    state.error = `Command submitted, but Activity could not refresh: ${message}`;
  }
}
