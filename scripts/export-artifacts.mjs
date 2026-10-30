import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = 'docs/artifacts';
const diagDir = join(outDir, 'diagrams');
mkdirSync(diagDir, { recursive: true });

const cacheDir = '.cache';
mkdirSync(cacheDir, { recursive: true });
const mermaidCachePath = join(cacheDir, 'mermaid.min.js');
let mermaidScript;
try {
  mermaidScript = readFileSync(mermaidCachePath, 'utf8');
} catch {
  console.log('Downloading mermaid.min.js to .cache...');
  const res = await fetch('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js');
  mermaidScript = await res.text();
  writeFileSync(mermaidCachePath, mermaidScript, 'utf8');
}

function extractMermaidBlocks(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const regex = /```mermaid\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      code: match[1].trim(),
      index: blocks.length + 1
    });
  }
  return blocks;
}

const diagramsMap = {
  'docs/artifacts/disruptioniq_data_flows_and_architectures.md': [
    { name: 'data_flow_end_to_end', title: 'End-to-End System Data Flow Architecture' },
    { name: 'inbound_signal_ingestion_pipeline', title: 'Inbound Signal Reconciliation & Ingestion Pipeline' },
    { name: 'impact_assessment_scoring_flow', title: 'Impact Assessment & Risk Scoring Logic Flow' },
    { name: 'recovery_strategy_authorization_pipeline', title: 'Recovery Strategy Feasibility & Two-Person Authorization Pipeline' },
    { name: 'state_lifecycle_event_intake', title: 'Event Intake Status Lifecycle' },
    { name: 'state_lifecycle_inventory_lot', title: 'Inventory Lot Status Lifecycle' },
    { name: 'state_lifecycle_recovery_plan', title: 'Recovery Plan Status Lifecycle' },
    { name: 'state_lifecycle_document_claim', title: 'Freight Document Claim Status Lifecycle' }
  ],
  'docs/artifacts/disruptioniq_implementation_report.md': [
    { name: 'seq_event_intake_disruption_detection', title: 'Sequence: Event Intake & Disruption Detection' },
    { name: 'seq_recovery_plan_authorization', title: 'Sequence: Recovery Plan Generation & Authorization' },
    { name: 'seq_document_extraction_review', title: 'Sequence: Document Extraction & Review' }
  ]
};

console.log('Launching headless browser...');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 1000 });

// Inject local mermaid script
await page.setContent(`
<!DOCTYPE html>
<html>
<head>
  <style>
    body { background: #ffffff; margin: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .mermaid { display: inline-block; }
  </style>
  <script>${mermaidScript}</script>
</head>
<body>
  <div id="container"></div>
</body>
</html>
`);

await page.evaluate(() => {
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' },
    sequence: { useMaxWidth: false }
  });
});

console.log('Rendering diagrams to SVG and PNG...');
const generatedDiagrams = [];

for (const [filePath, diagList] of Object.entries(diagramsMap)) {
  const blocks = extractMermaidBlocks(filePath);
  for (let i = 0; i < blocks.length; i++) {
    const meta = diagList[i] || { name: `diagram_${i+1}`, title: `Diagram ${i+1}` };
    const code = blocks[i].code;
    const svgId = `mermaid_${meta.name}`;

    try {
      const svgCode = await page.evaluate(async ({ id, code }) => {
        const { svg } = await window.mermaid.render(id, code);
        return svg;
      }, { id: svgId, code });

      const svgPath = join(diagDir, `${meta.name}.svg`);
      writeFileSync(svgPath, svgCode, 'utf8');

      // Screenshot to PNG as well
      await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body style="background:#ffffff; margin: 24px; padding: 0; display: inline-block;">
        ${svgCode}
      </body>
      </html>
      `);
      const element = await page.locator('svg').first();
      const pngPath = join(diagDir, `${meta.name}.png`);
      await element.screenshot({ path: pngPath, omitBackground: false });

      console.log(`Rendered: ${meta.name}.svg and ${meta.name}.png`);
      generatedDiagrams.push({
        name: meta.name,
        title: meta.title,
        svgFile: `${meta.name}.svg`,
        pngFile: `${meta.name}.png`,
        filePath
      });
    } catch (err) {
      console.error(`Failed to render ${meta.name}:`, err.message);
    }
  }
}

await browser.close();
console.log(`Successfully generated ${generatedDiagrams.length} accessible diagrams!`);

// Write DIAGRAMS.md catalog
const diagIndexMd = `# DisruptionIQ Architecture Diagrams Catalog

All flowcharts and sequence diagrams from the DisruptionIQ specifications have been rendered into scalable, high-resolution vector **SVG** (accessible with text elements) and raster **PNG** formats.

| Diagram Title | SVG Vector | PNG Image | Source Artifact |
| :--- | :--- | :--- | :--- |
${generatedDiagrams.map(d => `| **${d.title}** | [View SVG](./diagrams/${d.svgFile}) | [View PNG](./diagrams/${d.pngFile}) | \`${d.filePath.split('/').pop()}\` |`).join('\n')}

---

## Direct Diagram Previews

${generatedDiagrams.map(d => `
### ${d.title}
- **Formats**: [Vector SVG (Accessible, Scalable)](./diagrams/${d.svgFile}) · [Raster PNG](./diagrams/${d.pngFile})
- **Source**: \`${d.filePath.split('/').pop()}\`

![${d.title}](./diagrams/${d.svgFile})

---
`).join('\n')}
`;

writeFileSync(join(outDir, 'DIAGRAMS.md'), diagIndexMd, 'utf8');
console.log('Saved DIAGRAMS.md catalog.');

// Helper to convert Markdown to Standalone HTML
function markdownToHtml(mdText, title, activeFile) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - DisruptionIQ Docs</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --accent-green: #3fb950;
      --accent-orange: #d29922;
      --code-bg: #1f242c;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa;
        --card-bg: #ffffff;
        --border: #d0d7de;
        --text: #24292f;
        --text-bright: #0969da;
        --accent: #0969da;
        --accent-green: #1a7f37;
        --accent-orange: #9a6700;
        --code-bg: #f6f8fa;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      margin: 0;
      padding: 0;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 16px 32px;
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--text-bright);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    nav a {
      color: var(--text);
      text-decoration: none;
      margin-left: 20px;
      font-size: 0.95rem;
      padding: 6px 12px;
      border-radius: 6px;
      transition: background 0.2s;
    }
    nav a:hover, nav a.active {
      background: var(--border);
      color: var(--text-bright);
    }
    .container {
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .markdown-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 40px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    h1, h2, h3, h4 { color: var(--text-bright); margin-top: 1.5em; }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin-top: 0; }
    h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 10px 14px;
      text-align: left;
    }
    th { background: var(--code-bg); color: var(--text-bright); }
    .diagram-container {
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin: 24px 0;
      text-align: center;
      overflow-x: auto;
    }
    .diagram-container img, .diagram-container svg {
      max-width: 100%;
      height: auto;
    }
    .diagram-toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-bottom: 12px;
      font-size: 0.85rem;
    }
    .btn {
      display: inline-block;
      padding: 6px 12px;
      background: var(--border);
      color: var(--text-bright);
      text-decoration: none;
      border-radius: 6px;
      font-weight: 500;
    }
    .btn:hover { opacity: 0.85; }
    blockquote {
      border-left: 4px solid var(--accent);
      margin: 0;
      padding-left: 16px;
      color: var(--text);
    }
  </style>
</head>
<body>
  <header>
    <a href="index.html" class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      DisruptionIQ Documentation
    </a>
    <nav>
      <a href="index.html">Overview Portal</a>
      <a href="disruptioniq_implementation_report.html" class="${activeFile === 'report' ? 'active' : ''}">Implementation Report</a>
      <a href="disruptioniq_operations_reference.html" class="${activeFile === 'operations' ? 'active' : ''}">Operations Reference</a>
      <a href="disruptioniq_data_flows_and_architectures.html" class="${activeFile === 'flows' ? 'active' : ''}">Data Flows & Lifecycles</a>
      <a href="DIAGRAMS.md">Diagrams Catalog</a>
    </nav>
  </header>
  <div class="container">
    <div class="markdown-card">
      <div id="content"></div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    const rawMarkdown = ${JSON.stringify(mdText)};
    marked.setOptions({
      gfm: true,
      breaks: false
    });
    const html = marked.parse(rawMarkdown);
    document.getElementById('content').innerHTML = html;

    // Render mermaid blocks
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
    document.querySelectorAll('pre code.language-mermaid').forEach((block) => {
      const container = document.createElement('div');
      container.className = 'mermaid';
      container.textContent = block.textContent;
      const pre = block.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'diagram-container';
      wrap.appendChild(container);
      pre.parentElement.replaceChild(wrap, pre);
    });
  </script>
</body>
</html>
`;
}

// Generate the 3 HTML files
const reportMd = readFileSync('docs/artifacts/disruptioniq_implementation_report.md', 'utf8');
const opsMd = readFileSync('docs/artifacts/disruptioniq_operations_reference.md', 'utf8');
const flowsMd = readFileSync('docs/artifacts/disruptioniq_data_flows_and_architectures.md', 'utf8');

writeFileSync(join(outDir, 'disruptioniq_implementation_report.html'), markdownToHtml(reportMd, 'Implementation Report', 'report'), 'utf8');
writeFileSync(join(outDir, 'disruptioniq_operations_reference.html'), markdownToHtml(opsMd, 'Operations Technical Reference', 'operations'), 'utf8');
writeFileSync(join(outDir, 'disruptioniq_data_flows_and_architectures.html'), markdownToHtml(flowsMd, 'Data Flows & Architecture Models', 'flows'), 'utf8');

// Generate index.html Portal
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DisruptionIQ Technical Documentation & Artifacts</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --accent-green: #3fb950;
      --accent-orange: #d29922;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa;
        --card-bg: #ffffff;
        --border: #d0d7de;
        --text: #24292f;
        --text-bright: #0969da;
        --accent: #0969da;
        --accent-green: #1a7f37;
        --accent-orange: #9a6700;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      margin: 0;
      padding: 0;
    }
    .hero {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 60px 24px;
      text-align: center;
    }
    .hero h1 {
      font-size: 2.5rem;
      margin: 0 0 12px 0;
      color: var(--text-bright);
    }
    .hero p {
      font-size: 1.2rem;
      max-width: 700px;
      margin: 0 auto;
      color: var(--text);
    }
    .container {
      max-width: 1100px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 28px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: transform 0.2s, border-color 0.2s;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: var(--accent);
    }
    .card h2 {
      margin-top: 0;
      color: var(--text-bright);
      font-size: 1.4rem;
    }
    .card p {
      font-size: 0.95rem;
      color: var(--text);
      flex-grow: 1;
    }
    .links {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 8px 14px;
      background: var(--accent);
      color: #ffffff;
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .btn.secondary {
      background: var(--border);
      color: var(--text-bright);
    }
    .btn:hover { opacity: 0.9; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 12px;
      text-transform: uppercase;
    }
    .diagram-strip {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 24px;
    }
    .diagram-strip h3 { margin-top: 0; color: var(--text-bright); }
    .diag-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .diag-pill {
      background: var(--border);
      color: var(--text-bright);
      padding: 6px 12px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.85rem;
      transition: background 0.2s;
    }
    .diag-pill:hover { background: var(--accent); color: #fff; }
  </style>
</head>
<body>
  <div class="hero">
    <span class="badge">Operational Control Room Specs</span>
    <h1>DisruptionIQ Technical Documentation</h1>
    <p>Comprehensive system implementation reports, operations technical reference, data flow pipelines, and accessible vector flowcharts.</p>
  </div>

  <div class="container">
    <div class="grid">
      <!-- Card 1 -->
      <div class="card">
        <div>
          <span class="badge">Architecture & Verification</span>
          <h2>Implementation Report</h2>
          <p>Exhaustive inspection of implemented features, multi-tier dependency networks, RBAC security, carrier webhook, ground AI support, and 36 automated verification test suites.</p>
        </div>
        <div class="links">
          <a href="disruptioniq_implementation_report.html" class="btn">View Interactive HTML</a>
          <a href="disruptioniq_implementation_report.md" class="btn secondary">Raw Markdown (.md)</a>
        </div>
      </div>

      <!-- Card 2 -->
      <div class="card">
        <div>
          <span class="badge">Technical Reference</span>
          <h2>Operations Reference</h2>
          <p>Complete field-by-field and algorithm-by-algorithm reference of all operations: security primitives, concurrency mutexes, idempotency, constraints, and audit logging.</p>
        </div>
        <div class="links">
          <a href="disruptioniq_operations_reference.html" class="btn">View Interactive HTML</a>
          <a href="disruptioniq_operations_reference.md" class="btn secondary">Raw Markdown (.md)</a>
        </div>
      </div>

      <!-- Card 3 -->
      <div class="card">
        <div>
          <span class="badge">Flowcharts & Lifecycle</span>
          <h2>Data Flows & Architecture</h2>
          <p>Source-to-sink data pipeline models, state machine transitions, shortage scoring math, two-person authorization pipeline, and mathematical evaluation criteria.</p>
        </div>
        <div class="links">
          <a href="disruptioniq_data_flows_and_architectures.html" class="btn">View Interactive HTML</a>
          <a href="disruptioniq_data_flows_and_architectures.md" class="btn secondary">Raw Markdown (.md)</a>
        </div>
      </div>
    </div>

    <!-- Diagram Index -->
    <div class="diagram-strip">
      <h3>Accessible Vector Flowcharts (Scalable SVG & PNG)</h3>
      <p>Click any diagram to open the standalone scalable vector graphic in your browser:</p>
      <div class="diag-links">
        ${generatedDiagrams.map(d => `<a href="./diagrams/${d.svgFile}" target="_blank" class="diag-pill">${d.title} (SVG)</a>`).join('\n        ')}
      </div>
      <p style="margin-top: 18px;"><a href="DIAGRAMS.md" class="btn secondary">Browse Full Diagrams Gallery & Previews &rarr;</a></p>
    </div>
  </div>
</body>
</html>
`;

writeFileSync(join(outDir, 'index.html'), indexHtml, 'utf8');
console.log('Saved index.html portal.');
