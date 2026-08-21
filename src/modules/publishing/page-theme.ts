/**
 * Published page theme.
 *
 * The visual system for pages this OS publishes, matching the FaresMatch brand:
 * Plus Jakarta Sans, Material Symbols, the blue/green token palette, 1000px
 * content column, card grids and section rules.
 *
 * Components in the template library emit markup against these class names, so
 * changing the look is a change here rather than in every component.
 */
import { escapeHtml } from "@/core/utils/text";

export interface PageBrand {
  name: string;
  siteUrl: string;
  /**
   * Where the published site is actually served from. The local_static adapter
   * serves under /site, so root-relative hrefs are rewritten against this before
   * the document is written. Leave undefined for a CMS that serves at the root.
   */
  basePath?: string;
  /**
   * Site navigation, supplied by the operator. Deliberately empty by default:
   * inventing nav links to sections that do not exist would publish dead links,
   * which is exactly what the Technical SEO Agent then reports as errors.
   */
  nav?: { label: string; href: string }[];
  currentNav?: string;
  /** Line in the footer stating where the page's data came from. */
  dataSourceNote?: string;
}

export const PAGE_CSS = `
:root{
  --bg:#f6f7f8; --surface:#ffffff; --surface-2:#f8fafc; --rule:#e2e8f0;
  --ink:#1f2937; --ink-muted:#64748b;
  --brand:#0067ff; --brand-ink:#1565c0; --brand-soft:#eaf2ff;
  --cta:#16a34a; --cta-ink:#15803d; --cta-soft:#e9f9ef;
  --warn:#b45309; --warn-soft:#fef3e2;
  --font:'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0e1420; --surface:#161d2c; --surface-2:#1e2740; --rule:#2b3550;
    --ink:#e7ecf5; --ink-muted:#93a0be; --brand:#5b9bff; --brand-ink:#8fb8ff;
    --brand-soft:#152238; --cta:#34c978; --cta-ink:#6fe3a0; --cta-soft:#123324;
    --warn:#e3ac57; --warn-soft:#3a2c14;
  }
}
:root[data-theme="dark"]{
  --bg:#0e1420; --surface:#161d2c; --surface-2:#1e2740; --rule:#2b3550;
  --ink:#e7ecf5; --ink-muted:#93a0be; --brand:#5b9bff; --brand-ink:#8fb8ff;
  --brand-soft:#152238; --cta:#34c978; --cta-ink:#6fe3a0; --cta-soft:#123324;
  --warn:#e3ac57; --warn-soft:#3a2c14;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
img{max-width:100%}
a{color:inherit}
.msi{font-family:'Material Symbols Outlined';font-weight:normal;font-style:normal;font-size:18px;line-height:1;vertical-align:middle}

.data-note{background:var(--warn-soft);border-bottom:1px solid var(--rule);padding:9px 20px;font-size:12.5px;color:var(--ink-muted);text-align:center}
.data-note strong{color:var(--ink)}

header.site{display:flex;align-items:center;justify-content:space-between;padding:14px 32px;border-bottom:1px solid var(--rule);background:var(--surface)}
.logo{display:flex;align-items:center;gap:8px;font-weight:800;font-size:1.25rem;text-decoration:none}
.logo .mark{width:30px;height:30px;border-radius:8px;background:var(--brand);display:flex;align-items:center;justify-content:center;color:#fff}
.logo .mark .msi{font-size:17px}
.logo .fares{color:var(--brand)} .logo .match{color:var(--ink)}
nav.site-nav{display:flex;gap:26px;font-size:14px;color:var(--ink-muted)}
nav.site-nav a{color:inherit;text-decoration:none}
nav.site-nav a.current{color:var(--ink);font-weight:700}

.wrap{max-width:1000px;margin:0 auto;padding:0 24px}
.crumb{padding:14px 0 0;font-size:13px;color:var(--ink-muted)}
.crumb a{color:inherit;text-decoration:none}
.crumb a:hover{text-decoration:underline}

.search-dock{margin:18px 0 8px;background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:14px 16px;display:flex;align-items:center;flex-wrap:wrap}
.dock-field{flex:1;min-width:150px;padding:8px 14px;border-right:1px solid var(--rule)}
.dock-field:last-of-type{border-right:none}
.dock-label{font-size:11px;color:var(--ink-muted);display:flex;align-items:center;gap:5px}
.dock-label .msi{font-size:15px}
.dock-value{font-weight:700;font-size:14.5px;margin-top:2px}
.dock-value input,.dock-value select{border:none;background:transparent;font:inherit;color:inherit;width:100%;padding:0}
.dock-value input:focus,.dock-value select:focus{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
.dock-search{background:var(--cta);color:#fff;border:none;border-radius:8px;padding:12px 26px;font-family:var(--font);font-weight:800;font-size:14px;cursor:pointer;white-space:nowrap}

h1{font-weight:800;font-size:clamp(1.7rem,4vw,2.3rem);line-height:1.12;margin:22px 0 10px;text-wrap:balance}
.lede{color:var(--ink-muted);font-size:1rem;max-width:70ch;margin:0 0 8px}

.hero-photo{margin:18px 0 0;border-radius:14px;overflow:hidden;position:relative}
.hero-photo img{width:100%;height:260px;object-fit:cover;display:block}
.hero-band{margin:18px 0 0;border-radius:14px;height:132px;background:linear-gradient(120deg,var(--brand-soft),var(--surface-2));border:1px solid var(--rule);display:flex;align-items:center;justify-content:center;gap:10px;color:var(--brand-ink);font-weight:700}
.hero-band .msi{font-size:26px}

.fare-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap;background:var(--brand-soft);border:1px solid var(--rule);border-radius:14px;padding:22px 26px;margin:22px 0}
.fare-hero .label{font-size:12px;color:var(--brand-ink);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.fare-hero .price{font-weight:800;font-size:2.4rem;color:var(--ink);font-variant-numeric:tabular-nums;margin-top:2px}
.fare-hero .source{font-size:12.5px;color:var(--ink-muted);margin-top:2px}
.fare-hero .stats{display:flex;gap:22px;flex-wrap:wrap}
.fare-hero .stat{text-align:center}
.fare-hero .stat .v{font-weight:800;font-size:1.15rem;font-variant-numeric:tabular-nums}
.fare-hero .stat .k{font-size:11px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.03em}

section{padding:30px 0;border-top:1px solid var(--rule)}
h2{font-weight:800;font-size:1.25rem;margin:0 0 4px}
h3{font-size:1.02rem;font-weight:700}
.section-sub{color:var(--ink-muted);font-size:14px;margin:0 0 18px;max-width:66ch}
.prose p{margin:0 0 12px;max-width:70ch}
.prose p:last-child{margin-bottom:0}
.prose ul{margin:0 0 12px;padding-left:20px;max-width:70ch}
.prose li{margin-bottom:6px}

.answer{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--brand);border-radius:12px;padding:16px 20px;margin:22px 0 0}
.answer p{margin:0;font-size:1.02rem;font-weight:600;max-width:72ch}

.chart-card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:20px 20px 12px}
.chart-scroll{overflow-x:auto}
.chart-legend{display:flex;gap:18px;font-size:12.5px;color:var(--ink-muted);margin-top:10px;flex-wrap:wrap}
.chart-legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}

.chip-row{display:flex;flex-wrap:wrap;gap:9px}
.chip{background:var(--surface);border:1px solid var(--rule);border-radius:999px;padding:8px 16px;font-size:14px;font-weight:600;text-decoration:none;display:inline-block}
a.chip:hover{border-color:var(--brand);color:var(--brand-ink)}

.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:18px 20px;overflow:hidden}
.card.card-photo{padding:0 0 18px}
.card .tag{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--brand-ink);background:var(--brand-soft);padding:3px 9px;border-radius:6px;margin:0 0 8px}
.card.card-photo .tag{margin:14px 20px 8px}
.card h3{margin:0 0 6px}
.card.card-photo h3{margin:0 20px 6px}
.card p{font-size:13.5px;color:var(--ink-muted);margin:0 0 10px}
.card.card-photo p{margin:0 20px 10px}
.card .meta{display:flex;gap:16px;flex-wrap:wrap}
.card.card-photo .meta{margin:0 20px}
.card .meta .k{color:var(--ink-muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
.card .meta .v{font-weight:700;font-size:13px}
.card a.card-link{color:var(--brand-ink);font-weight:700;font-size:13px;text-decoration:none}

.img-wrap{position:relative}
.card-img{width:100%;height:170px;object-fit:cover;display:block}
.img-credit{position:absolute;bottom:6px;right:8px;background:rgba(0,0,0,.55);color:#fff;font-size:9.5px;padding:2px 7px;border-radius:4px}

.faq-item{padding:15px 0;border-bottom:1px solid var(--rule)}
.faq-item:last-child{border-bottom:none}
.faq-q{font-weight:700;margin:0 0 5px;display:flex;align-items:center;gap:8px}
.faq-q .msi{font-size:16px;color:var(--brand-ink)}
.faq-a{color:var(--ink-muted);margin:0;font-size:14px;padding-left:24px;max-width:70ch}

.cta-band{background:var(--surface-2);border:1px solid var(--rule);border-radius:14px;padding:26px 28px;margin:30px 0 0;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.cta-band h3{margin:0 0 4px;font-size:1.1rem}
.cta-band p{margin:0;color:var(--ink-muted);font-size:13.5px}
.cta-btn{background:var(--cta);color:#fff;border:none;border-radius:8px;padding:12px 24px;font-family:var(--font);font-weight:800;font-size:14px;text-decoration:none;display:inline-block}

.sources{font-size:13px;color:var(--ink-muted)}
.sources ul{list-style:none;padding:0;margin:0}
.sources li{padding:7px 0;border-bottom:1px solid var(--rule)}
.sources li:last-child{border-bottom:none}
.sources .ref{display:inline-block;background:var(--surface-2);border:1px solid var(--rule);border-radius:5px;padding:1px 7px;font-size:11px;margin-left:6px}

.trust{color:var(--ink-muted);font-size:13px;max-width:70ch}

footer.site{border-top:1px solid var(--rule);margin-top:30px}
footer.site .inner{max-width:1000px;margin:0 auto;padding:26px 24px 44px;color:var(--ink-muted);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}

@media (max-width:640px){
  header.site{padding:12px 18px}
  .fare-hero{flex-direction:column;align-items:flex-start}
  .dock-field{border-right:none;border-bottom:1px solid var(--rule)}
  .dock-search{width:100%;margin-top:10px}
}
`;

/** Site chrome above the page content. */
export function renderHeader(brand: PageBrand): string {
  const links = (brand.nav ?? [])
    .map(
      (n) =>
        `<a href="${escapeHtml(n.href)}"${brand.currentNav && n.label === brand.currentNav ? ' class="current"' : ""}>${escapeHtml(n.label)}</a>`,
    )
    .join("");

  const [first, ...rest] = brand.name.split(/(?=[A-Z])/);
  const second = rest.join("");

  return `    <header class="site">
      <a class="logo" href="${escapeHtml(brand.basePath || brand.siteUrl)}">
        <span class="mark"><span class="msi">send</span></span>
        <span class="fares">${escapeHtml(first || brand.name)}</span><span class="match">${escapeHtml(second)}</span>
      </a>
${links ? `      <nav class="site-nav">${links}</nav>
` : ""}    </header>`;
}

export function renderFooter(brand: PageBrand, url: string): string {
  const path = `${brand.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}${url}`;
  return `    <footer class="site">
      <div class="inner">
        <span>${escapeHtml(path)}</span>
        <span>${escapeHtml(brand.dataSourceNote ?? "")}</span>
      </div>
    </footer>`;
}

/**
 * Provenance banner.
 *
 * Rendered only when the page leans on reference rather than live data. It is
 * the same rule the rest of the OS follows: never let approximate data read as
 * measured data.
 */
export function renderDataNotice(notice?: string): string {
  if (!notice) return "";
  return `    <div class="data-note"><strong>Data note</strong> — ${escapeHtml(notice)}</div>`;
}

export const FONT_LINKS = `    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Material+Symbols+Outlined:opsz,wght,FILL@20..48,300..500,0..1&display=swap" rel="stylesheet">`;

// --- shared markup helpers used by components ------------------------------

export function section(id: string, heading: string | null, subtitle: string | null, body: string): string {
  const h = heading ? `        <h2>${escapeHtml(heading)}</h2>\n` : "";
  const s = subtitle ? `        <p class="section-sub">${escapeHtml(subtitle)}</p>\n` : "";
  return `      <section id="${id}">\n${h}${s}${body}\n      </section>`;
}

export function cardGrid(cards: string[]): string {
  return `        <div class="card-grid">\n${cards.join("\n")}\n        </div>`;
}

export interface CardSpec {
  tag?: string;
  title: string;
  body?: string;
  meta?: { k: string; v: string }[];
  href?: string;
  linkLabel?: string;
  image?: { src: string; alt: string; credit?: string };
}

export function card(spec: CardSpec): string {
  const photo = spec.image
    ? `            <div class="img-wrap"><img class="card-img" src="${escapeHtml(spec.image.src)}" alt="${escapeHtml(spec.image.alt)}" loading="lazy">${
        spec.image.credit ? `<div class="img-credit">${escapeHtml(spec.image.credit)}</div>` : ""
      }</div>\n`
    : "";

  const tag = spec.tag ? `            <span class="tag">${escapeHtml(spec.tag)}</span>\n` : "";
  const body = spec.body ? `            <p>${escapeHtml(spec.body)}</p>\n` : "";
  const meta = spec.meta?.length
    ? `            <div class="meta">${spec.meta
        .map((m) => `<div><div class="k">${escapeHtml(m.k)}</div><div class="v">${escapeHtml(m.v)}</div></div>`)
        .join("")}</div>\n`
    : "";
  const link = spec.href
    ? `            <div style="margin-top:10px"><a class="card-link" href="${escapeHtml(spec.href)}">${escapeHtml(spec.linkLabel ?? "View")} →</a></div>\n`
    : "";

  const title = spec.href
    ? `            <h3><a href="${escapeHtml(spec.href)}" style="text-decoration:none">${escapeHtml(spec.title)}</a></h3>\n`
    : `            <h3>${escapeHtml(spec.title)}</h3>\n`;

  return `          <div class="card${spec.image ? " card-photo" : ""}">\n${photo}${tag}${title}${body}${meta}${link}          </div>`;
}

export function chips(items: { label: string; href?: string }[]): string {
  return `        <div class="chip-row">${items
    .map((i) =>
      i.href
        ? `<a class="chip" href="${escapeHtml(i.href)}">${escapeHtml(i.label)}</a>`
        : `<span class="chip">${escapeHtml(i.label)}</span>`,
    )
    .join("")}</div>`;
}

export function prose(text: string): string {
  return `        <div class="prose">\n${text
    .split(/\n{2,}/)
    .map((p) => `          <p>${escapeHtml(p.trim())}</p>`)
    .join("\n")}\n        </div>`;
}

/**
 * Line chart as inline SVG.
 *
 * Deliberately dependency-free and server-rendered: a published page should not
 * need JavaScript to show its own data.
 */
export function lineChart(
  points: { label: string; value: number }[],
  opts: { format?: (n: number) => string; height?: number } = {},
): string {
  if (points.length < 2) return "";
  const format = opts.format ?? ((n: number) => String(Math.round(n)));
  const height = opts.height ?? 190;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || Math.max(max * 0.02, 1);
  const lo = min - pad;
  const hi = max + pad;

  const x0 = 40;
  const x1 = 620;
  const yTop = 20;
  const yBottom = 145;
  const scaleX = (i: number) => x0 + (i / (points.length - 1)) * (x1 - x0);
  const scaleY = (v: number) => yBottom - ((v - lo) / (hi - lo)) * (yBottom - yTop);

  const poly = points.map((p, i) => `${scaleX(i).toFixed(1)},${scaleY(p.value).toFixed(1)}`).join(" ");
  const cheapestIndex = values.indexOf(min);
  const priciestIndex = values.indexOf(max);

  const labels = points
    .map((p, i) =>
      i === 0 || i === points.length - 1 || i === cheapestIndex
        ? `<text x="${scaleX(i).toFixed(1)}" y="163" text-anchor="middle" font-size="10" fill="var(--ink-muted)">${escapeHtml(p.label)}</text>`
        : "",
    )
    .join("");

  return `        <div class="chart-scroll">
          <svg viewBox="0 0 640 ${height}" width="100%" height="${height}" role="img" aria-label="Series from ${escapeHtml(format(min))} to ${escapeHtml(format(max))}">
            <line x1="${x0}" y1="${yTop}" x2="${x0}" y2="${yBottom}" stroke="var(--rule)" stroke-width="1"/>
            <line x1="${x0}" y1="${yBottom}" x2="${x1}" y2="${yBottom}" stroke="var(--rule)" stroke-width="1"/>
            <text x="${x0 - 6}" y="${yTop + 4}" text-anchor="end" font-size="10" fill="var(--ink-muted)">${escapeHtml(format(hi))}</text>
            <text x="${x0 - 6}" y="${yBottom}" text-anchor="end" font-size="10" fill="var(--ink-muted)">${escapeHtml(format(lo))}</text>
            <polyline points="${poly}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="${scaleX(cheapestIndex).toFixed(1)}" cy="${scaleY(min).toFixed(1)}" r="5" fill="var(--cta)"/>
            <circle cx="${scaleX(priciestIndex).toFixed(1)}" cy="${scaleY(max).toFixed(1)}" r="5" fill="var(--warn)"/>
            ${labels}
          </svg>
        </div>`;
}

/**
 * Rewrites root-relative links so they resolve where the site is actually
 * served. The adapter knows its own base path; components stay ignorant of it
 * and keep emitting canonical site-relative URLs.
 *
 * External URLs, fragments, mailto/tel and paths already under the base are
 * left alone.
 */
/**
 * The same rebasing, applied to structured data.
 *
 * Schema URLs that disagree with the links on the page are a real SEO defect,
 * so both go through the base path or neither does.
 */
export function rebaseJsonLd<T>(value: T, origin: string, basePath?: string): T {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base) return value;
  const root = origin.replace(/\/+$/, "");

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith(`${root}${base}/`) || v === `${root}${base}`) return v;
      if (v.startsWith(`${root}/`)) return `${root}${base}${v.slice(root.length)}`;
      if (v === `${root}` || v === `${root}/`) return `${root}${base}/`;
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };

  return walk(value) as T;
}

export function applyBasePath(html: string, basePath?: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base) return html;
  return html.replace(/\b(href|action)="\/([^"]*)"/g, (match, attr, rest) => {
    if (rest.startsWith(base.slice(1) + "/") || `/${rest}` === base) return match;
    return `${attr}="${base}/${rest}"`;
  });
}
