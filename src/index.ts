// @boardwalk-labs/runner — the self-hosted runner client (Phase 3).
//
// What exists today is the CONTRACT: the canonical registration / assignment / claim /
// heartbeat / status payload schemas the runner and the Boardwalk control plane agree on.
// The client implementation (register, poll, execute, stream) lands when Boardwalk self-hosted
// runners ship; it will consume exactly these types.

export * from "./contract.js";
