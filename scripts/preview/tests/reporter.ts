import fs from "node:fs";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

/**
 * Writes a machine-readable and human-readable failure artifact for the
 * preview suite. Each entry names the route, navigation tab and group so a
 * failure is actionable without opening the Playwright HTML report.
 */
type FailureEntry = {
  title: string;
  project: string;
  status: string;
  route: string | null;
  group: string | null;
  tab: string | null;
  retry: number;
  error: string;
  url: string | null;
};

type ReporterOptions = {
  outputDir?: string;
  filePrefix?: string;
  title?: string;
};

export default class PreviewFailureReporter implements Reporter {
  private failures: FailureEntry[] = [];
  private outputDir: string;
  private filePrefix: string;
  private title: string;

  constructor(options: ReporterOptions = {}) {
    this.outputDir = options.outputDir ?? path.resolve(process.cwd(), "test-results");
    this.filePrefix = options.filePrefix ?? "preview";
    this.title = options.title ?? "Docs preview failures";
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "passed" || result.status === "skipped") return;

    const annotation = (type: string) =>
      test.annotations.find((entry) => entry.type === type)?.description ?? null;

    const urlAttachment = result.attachments.find((attachment) => attachment.name === "url");
    this.failures.push({
      title: test.title,
      project: test.parent.project()?.name ?? "unknown",
      status: result.status,
      route: annotation("route"),
      group: annotation("nav-group"),
      tab: annotation("nav-tab"),
      retry: result.retry,
      error: result.error?.message?.trim() || "No error message recorded.",
      url: urlAttachment?.body ? urlAttachment.body.toString() : result.error?.location?.file ?? null,
    });
  }

  onEnd(result: FullResult) {
    if (this.failures.length === 0) return;

    fs.mkdirSync(this.outputDir, { recursive: true });
    const jsonPath = path.join(this.outputDir, `${this.filePrefix}-failures.json`);
    const markdownPath = path.join(this.outputDir, `${this.filePrefix}-failures.md`);

    fs.writeFileSync(jsonPath, `${JSON.stringify({ status: result.status, failures: this.failures }, null, 2)}\n`);

    const lines = [
      `# ${this.title}`,
      "",
      `Status: ${result.status}`,
      "",
      "| Project | Tab | Group | Route | Test | Status |",
      "|---|---|---|---|---|---|",
      ...this.failures.map(
        (failure) =>
          `| ${failure.project} | ${failure.tab ?? "?"} | ${failure.group ?? "?"} | ${failure.route ?? "?"} | ${failure.title} | ${failure.status} |`,
      ),
      "",
      "## Details",
      "",
      ...this.failures.flatMap((failure) => [
        `### ${failure.project} · ${failure.group ?? "?"} · ${failure.route ?? "?"}`,
        "",
        `**Test:** ${failure.title} (retry ${failure.retry})`,
        "",
        "```",
        failure.error,
        "```",
        "",
      ]),
    ];

    fs.writeFileSync(markdownPath, lines.join("\n"));
    console.log(
      `Preview failure artifacts: ${path.relative(process.cwd(), jsonPath)}, ${path.relative(process.cwd(), markdownPath)}`,
    );
  }
}
