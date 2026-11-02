const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Retained phases require a separate authenticated host protocol; never fall through to the legacy worker.
export function parseRestoreWorkerArguments(args: readonly string[]) {
  if (args.length !== 1 || !args[0] || !uuid.test(args[0])) throw new Error('Invalid restore worker invocation');
  return args[0];
}
