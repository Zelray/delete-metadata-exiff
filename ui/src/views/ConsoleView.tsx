import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiErrorCode } from '@metadesk/shared';
import { runConsole, type ConsoleRunResult } from '../api/client';
import { splitArgs } from '../lib/splitArgs';
import { CommandPreviewChips } from '../components/CommandPreviewChips';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { useUiStore } from '../state/store';
import { copyText } from '../lib/clipboard';

/**
 * Raw Command Console — READ-ONLY in this leaf (ux-spec + BUILD-NOTES pin):
 * POST /api/console/run executes only read-flag commands through the
 * server's strict validator. Write-class tokens are refused with a human
 * message, shown here verbatim.
 */
export function ConsoleView() {
  const consoleHistory = useUiStore((s) => s.consoleHistory);
  const pushConsoleHistory = useUiStore((s) => s.pushConsoleHistory);
  const draft = useUiStore((s) => s.consoleDraft);
  const setConsoleDraft = useUiStore((s) => s.setConsoleDraft);
  const recordCommand = useUiStore((s) => s.recordCommand);
  const setNextCommand = useUiStore((s) => s.setNextCommand);

  const [line, setLine] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConsoleRunResult | null>(null);
  const [failure, setFailure] = useState<{ code: ApiErrorCode | 'transport'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  // Arrivals from the Command Preview drawer's "Open in Console".
  useEffect(() => {
    if (draft.length > 0) {
      setLine(draft.map(quote).join(' '));
      setConsoleDraft([]);
    }
  }, [draft, setConsoleDraft]);

  const argv = useMemo(() => splitArgs(line), [line]);

  const run = async () => {
    if (argv.length === 0 || running) return;
    setRunning(true);
    setFailure(null);
    setNextCommand(argv, 'console run', true);
    try {
      const response = await runConsole(argv);
      setResult(response);
      recordCommand({ argv, label: 'console', readOnly: true, ok: true });
      pushConsoleHistory(line.trim());
    } catch (error) {
      setResult(null);
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? ((error as { code: ApiErrorCode }).code ?? 'internal_error')
          : 'transport';
      setFailure({ code, message });
      recordCommand({ argv, label: 'console', readOnly: true, ok: false });
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [result]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Console</h1>
        <p className="text-sm text-muted-foreground">
          The full CLI escape hatch, read-side. Every command runs through a strict validator that
          refuses anything that could change a file — no <code className="font-mono">=</code>{' '}
          assignments, no overwrite flags, no output files.
        </p>
      </header>

      <div
        role="status"
        className="rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground"
      >
        Read-only by design in this session. Editing commands arrive with Write Unlocked and the
        same Save Review gate as everywhere else.
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Command</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <input
              value={line}
              onChange={(event) => setLine(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run();
              }}
              placeholder={'-ver     or     -j -G1 -a -struct "C:\\Photos\\IMG_2041.jpg"'}
              aria-label="exiftool arguments"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-input bg-card px-3 font-mono text-sm"
            />
            <Button variant="primary" onClick={() => void run()} disabled={argv.length === 0 || running}>
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>

          {argv.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Exactly what will run — hover a token for what it means
              </div>
              <CommandPreviewChips argv={argv} />
            </div>
          )}

          {consoleHistory.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <label className="text-muted-foreground" htmlFor="console-history">
                History
              </label>
              <select
                id="console-history"
                value=""
                onChange={(event) => {
                  if (event.target.value !== '') setLine(event.target.value);
                }}
                className="h-7 rounded border border-input bg-card px-1.5 text-xs"
              >
                <option value="">Recent commands…</option>
                {consoleHistory.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      {failure !== null && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge tone="danger">{failure.code}</Badge>
            <span className="font-medium">The validator refused this command.</span>
          </div>
          <div className="mt-1">{failure.message}</div>
          <div className="mt-1 text-muted-foreground">
            Nothing ran, nothing changed. Remove the offending token and run again — or use the
            friendly fields in the inspector for edits once write mode lands.
          </div>
        </div>
      )}

      {result !== null && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Output</CardTitle>
            <span className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void copyText(stdoutOf(result)).then((ok) => {
                    setCopied(ok);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy output'}
              </Button>
            </span>
          </CardHeader>
          <CardContent>
            <pre
              ref={outputRef}
              className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
            >
              {stdoutOf(result) || '(no output)'}
            </pre>
            {(result.stderr ?? '').trim() !== '' && (
              <div className="mt-2">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  stderr
                </div>
                <pre className="max-h-40 overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-warning">
                  {result.stderr}
                </pre>
              </div>
            )}
            {result.diagnostics !== undefined && result.diagnostics.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {result.diagnostics.map((diagnostic, index) => (
                  <li
                    key={index}
                    className={diagnostic.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}
                  >
                    [{diagnostic.severity}] {diagnostic.message}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function stdoutOf(result: ConsoleRunResult): string {
  if (typeof result.stdout === 'string') return result.stdout;
  // Lenient: leaf 1.1.2 owns the exact response shape; render what exists.
  const json = result['json'];
  if (Array.isArray(json)) return JSON.stringify(json, null, 2);
  return '';
}

function quote(token: string): string {
  return token.includes(' ') ? `"${token}"` : token;
}
