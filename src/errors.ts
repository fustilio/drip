// Thrown for expected, user-actionable failures (bad branch, bad args, missing
// repo). main() catches these and prints just the message — no stack trace.
// Anything else thrown is a real bug and should show its stack.
export class DripError extends Error {}
