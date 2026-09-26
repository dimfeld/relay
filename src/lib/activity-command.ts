export interface ActivityCommandSubmission {
  text: string;
  submissionId: string;
}

export interface ActivityCommandFormState {
  text: string;
  pending: boolean;
  eventId: string | null;
  error: string | null;
  submission: { id: string; text: string } | null;
}

export function createActivityCommandFormState(): ActivityCommandFormState {
  return {
    text: "",
    pending: false,
    eventId: null,
    error: null,
    submission: null,
  };
}

export async function submitActivityCommandForm(
  state: ActivityCommandFormState,
  submit: (input: ActivityCommandSubmission) => Promise<string>,
  refresh: () => Promise<unknown>
): Promise<void> {
  if (state.pending || !state.text.trim()) return;

  const text = state.text;
  if (state.submission?.text !== text) {
    state.submission = { id: crypto.randomUUID(), text };
  }
  state.pending = true;
  state.error = null;
  state.eventId = null;

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
