/**
 * PersistentClaude — ONE long-lived `claude` stream-json session, reused across
 * queries so we never re-pay CLI startup per synthesis. Option B: free (the
 * user's own OAuth login, read by `claude` itself) + fast (process stays warm).
 *
 * Protocol (verified by probe): spawn
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 * then per turn write one NDJSON user message to stdin and read stdout lines
 * until that turn's {type:"result"} event (.result = text, .is_error = failed).
 *
 * Queries are SERIALIZED (one turn at a time). The process is RECYCLED every
 * MAX_TURNS to bound conversation-history growth, and respawned lazily on the
 * next query if it dies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type Interface, createInterface } from "node:readline";

const MAX_TURNS = 8;
const QUERY_TIMEOUT_MS = 20000;
const STDERR_KEEP = 500;

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResultEvent {
  type?: string;
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

export class PersistentClaude {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private stderr = "";
  private pending: Pending | null = null;
  private turns = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly model: string,
    private readonly systemPrompt: string,
  ) {}

  /** Serialized: each query waits for the previous turn to settle. */
  query(userText: string): Promise<string> {
    const run = this.chain.then(() => this.runTurn(userText));
    this.chain = run.catch(() => undefined); // never rejects → next query proceeds
    return run;
  }

  dispose(): void {
    this.teardown(new Error("disposed"));
  }

  private ensureStarted(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", this.model,
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--append-system-prompt", this.systemPrompt,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.stderr = "";
    this.turns = 0;
    this.rl = createInterface({ input: child.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_KEEP);
    });
    child.on("error", (e) => this.teardown(e));
    child.on("close", () =>
      this.teardown(
        new Error(
          `claude session closed${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
        ),
      ),
    );
    return child;
  }

  private onLine(line: string): void {
    if (!this.pending) return;
    const text = line.trim();
    if (!text) return;
    let evt: ResultEvent;
    try {
      evt = JSON.parse(text) as ResultEvent;
    } catch {
      return; // non-JSON or partial — ignore
    }
    if (evt.type !== "result") return;

    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    if (evt.is_error) {
      p.reject(new Error(`claude result error: ${evt.subtype ?? "unknown"}`));
    } else if (typeof evt.result === "string") {
      p.resolve(evt.result.trim());
    } else {
      p.reject(new Error("claude result missing text"));
    }
  }

  /**
   * Tear down the session. With `err`: reject any in-flight turn + SIGKILL.
   * Without: a routine recycle (SIGTERM); the previous turn already settled.
   */
  private teardown(err?: Error): void {
    if (err && this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(err);
      this.pending = null;
    }
    this.rl?.close();
    this.rl = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill(err ? "SIGKILL" : "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  private runTurn(userText: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.ensureStarted();
      const timer = setTimeout(
        () => this.teardown(new Error("claude query timeout")),
        QUERY_TIMEOUT_MS,
      );
      this.pending = { resolve, reject, timer };
      this.turns++;
      const msg = `${JSON.stringify({
        type: "user",
        message: { role: "user", content: userText },
      })}\n`;
      try {
        child.stdin?.write(msg);
      } catch (e) {
        this.teardown(e as Error);
      }
    }).finally(() => {
      if (this.turns >= MAX_TURNS) this.teardown(); // routine recycle
    });
  }
}
