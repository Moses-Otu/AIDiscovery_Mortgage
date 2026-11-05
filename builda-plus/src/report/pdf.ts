import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import type { ReportModel } from './model';

const C = { ink: '#1C2B3A', muted: '#56657A', green: '#2E6B58', line: '#C9D1D9', warn: '#7A4E0E', soft: '#EEF1F3' };

export function renderReportPdf(model: ReportModel, opts: { fontDir?: string; compress?: boolean } = {}): Promise<Buffer> {
  const fontDir = opts.fontDir ?? join(process.cwd(), 'public', 'fonts');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 72, left: 64, right: 64 }, bufferPages: true, compress: opts.compress ?? true,
    info: { Title: `Discovery report — ${model.firmName}`, Author: 'builda+ by JADA', Subject: 'Operational discovery report' } });
  doc.registerFont('serif', join(fontDir, 'SourceSerif4-Regular.ttf'));
  doc.registerFont('serif-bold', join(fontDir, 'SourceSerif4-Semibold.ttf'));
  doc.registerFont('sans', join(fontDir, 'AtkinsonHyperlegible-Regular.ttf'));
  doc.registerFont('sans-bold', join(fontDir, 'AtkinsonHyperlegible-Bold.ttf'));

  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 128;

  const ensure = (h: number) => { if (doc.y + h > doc.page.height - 80) doc.addPage(); };
  const h1 = (t: string) => { ensure(80); doc.moveDown(1.2).font('serif-bold').fontSize(18).fillColor(C.ink).text(t); doc.moveDown(0.4); };
  const h2 = (t: string) => { ensure(72); doc.moveDown(0.7).font('sans-bold').fontSize(11).fillColor(C.ink).text(t); doc.moveDown(0.2); };
  const para = (t: string, color = C.ink) => doc.font('sans').fontSize(10).fillColor(color).text(t, { lineGap: 2.5 });
  const bullets = (items: string[], color = C.ink) => { for (const i of items) { ensure(20); doc.font('sans').fontSize(10).fillColor(color).text(`•  ${i}`, { indent: 0, lineGap: 2.5 }); doc.moveDown(0.15); } };
  const rows = (pairs: { label: string; value: string }[]) => {
    for (const r of pairs) {
      ensure(18);
      const y = doc.y;
      doc.font('sans').fontSize(9.5).fillColor(C.muted).text(r.label, 64, y, { width: 190 });
      const h1y = doc.y;
      doc.font('sans').fontSize(9.5).fillColor(C.ink).text(r.value, 264, y, { width: W - 200 });
      doc.y = Math.max(h1y, doc.y) + 3; doc.x = 64;
    }
  };
  const quote = (q: { role: string; quote: string }) => {
    ensure(24);
    const y = doc.y;
    doc.font('serif').fontSize(10.5).fillColor(C.ink).text(`“${q.quote}”`, 76, y, { width: W - 12 });
    doc.font('sans').fontSize(8.5).fillColor(C.muted).text(q.role, 76);
    doc.moveTo(66, y).lineTo(66, doc.y).lineWidth(1.5).strokeColor(C.line).stroke();
    doc.x = 64; doc.moveDown(0.35);
  };

  // ---- cover ----
  doc.font('sans').fontSize(10).fillColor(C.green).text('builda+ discovery report');
  doc.moveDown(2.5);
  doc.font('serif-bold').fontSize(30).fillColor(C.ink).text(model.firmName, { lineGap: 2 });
  doc.font('serif').fontSize(16).fillColor(C.muted).text('How work moves through the business, and where to improve it first');
  doc.moveDown(1.5);
  doc.font('sans').fontSize(9.5).fillColor(C.muted).text(`Version ${model.version}, generated ${new Date(model.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`);
  doc.moveDown(2.5);
  if (model.knowledge && !model.knowledge.reviewed) {
    doc.font('sans-bold').fontSize(10).fillColor(C.warn).text('Draft: produced with an unreviewed development playbook. Not for use with a real firm.');
    doc.moveDown(0.5);
  }
  h2('In brief');
  bullets(model.summary);
  h2('How to read this report');
  bullets(model.disclaimers, C.muted);

  // ---- firm ----
  doc.addPage();
  h1('Your firm');
  if (model.profile.length) rows(model.profile); else para('The firm profile has not been completed.', C.muted);
  h2('Who took part');
  rows(model.participation.map((p) => ({ label: p.role, value: `${p.completed} of ${p.total} completed` })));

  h1('Your mortgage journey');
  para('Where reported pain points sit. Stages marked “adviser judgement” involve regulated decisions: automation there may only prepare information.', C.muted);
  doc.moveDown(0.4);
  model.journey.forEach((s, i) => {
    ensure(20);
    const y = doc.y;
    doc.font('sans').fontSize(9).fillColor(C.muted).text(String(i + 1), 64, y, { width: 20 });
    doc.font('sans-bold').fontSize(9.5).fillColor(C.ink).text(s.stage, 88, y, { width: 170 });
    let ly = doc.y;
    if (s.regulated) { doc.font('sans').fontSize(8).fillColor(C.warn).text('Adviser judgement', 88, doc.y, { width: 170 }); ly = doc.y; }
    doc.font('sans').fontSize(9.5).fillColor(s.painPoints.length ? C.ink : C.muted).text(s.painPoints.join('; ') || '—', 268, y, { width: W - 204 });
    doc.y = Math.max(ly, doc.y) + 4; doc.x = 64;
    doc.moveTo(64, doc.y - 2).lineTo(64 + W, doc.y - 2).lineWidth(0.5).strokeColor(C.line).stroke();
  });

  // ---- business cases ----
  doc.addPage();
  h1('Top opportunities');
  if (!model.businessCases.length) para('No opportunities have enough evidence to rank yet.', C.muted);
  model.businessCases.forEach((b, i) => {
    if (i > 0) doc.addPage(); // one business case per page
    doc.font('serif-bold').fontSize(26).fillColor(C.green).text(String(b.rank));
    doc.font('serif-bold').fontSize(14).fillColor(C.ink).text(b.title);
    doc.font('sans').fontSize(9.5).fillColor(C.muted).text(`${b.stage} · ${b.approach} · Evidence: ${b.confidence}`);
    if (b.requiresComplianceReview) doc.font('sans-bold').fontSize(9).fillColor(C.warn).text('Requires compliance review before any change');
    h2('What happens today'); bullets(b.currentProcess);
    if (b.evidence.length) { h2('What people said'); b.evidence.forEach(quote); }
    h2('The numbers'); rows(b.figures);
    if (b.unknowns.length) para(`Still unknown: ${b.unknowns.join(', ').toLowerCase()}.`, C.muted);
    h2('Proposed improvement'); bullets(b.improvement);
    rows([{ label: 'Implementation complexity', value: b.complexity }, { label: 'Payback', value: b.payback }]);
    if (b.assumptions.length) { h2('Assumptions'); bullets(b.assumptions, C.muted); }
  });

  if (model.otherFindings.length) {
    h1('Other findings');
    rows(model.otherFindings.map((o) => ({ label: o.title, value: `${o.stage}. ${o.approach}. Evidence: ${o.confidence}.${o.note ? ` ${o.note}.` : ''}` })));
  }

  h1('Across roles');
  h2('Where people agreed'); bullets(model.crossRole.agreements.length ? model.crossRole.agreements : ['No item was yet described consistently by several people.']);
  h2('Where accounts differed');
  if (model.crossRole.differences.length) model.crossRole.differences.forEach((d) => bullets([`${d.title}. ${d.detail}.`]));
  else bullets(['No material differences.']);
  para('Differences are not errors. They often show that the same task varies between cases or roles, and are worth a conversation.', C.muted);
  h2('Raised by staff but not by management');
  bullets(model.crossRole.blindSpots === null ? ['Not available: the firm lead has not completed an interview.'] : model.crossRole.blindSpots.length ? model.crossRole.blindSpots : ['None.']);
  if (model.crossRole.unreportedStages.length) { h2('Stages nobody described'); para(model.crossRole.unreportedStages.join(', ') + '.'); }

  h1('Recommended two-week build');
  para(model.recommendedBuild.text);
  if (model.recommendedBuild.blockers.length) { h2('What needs to happen first'); bullets(model.recommendedBuild.blockers); }
  if (model.recommendedBuild.toConfirm.length) { h2('To confirm in JADA engineering review'); bullets(model.recommendedBuild.toConfirm, C.muted); }

  h1('Points for compliance review');
  for (const r of model.regulatoryItems ?? []) {
    ensure(60);
    doc.font('sans-bold').fontSize(10).fillColor(C.ink).text(`${r.title} — ${r.stage}`);
    if (r.notCovered) para('Not covered by the approved knowledge base. Refer this to a qualified compliance reviewer before making any change.', C.warn);
    for (const c of r.checks) {
      ensure(40);
      doc.font('sans').fontSize(10).fillColor(C.ink).text(`${c.title}: ${c.requiredAction}`, { lineGap: 2.5 });
      for (const cite of c.citations) doc.font('sans').fontSize(8.5).fillColor(C.muted).text(`Source: ${cite}`, { lineGap: 1.5 });
    }
    doc.moveDown(0.5);
  }
  bullets(model.regulatoryReview);
  if (model.outstandingQuestions.length) { h1('Open questions'); bullets(model.outstandingQuestions); }
  if (model.toProceed.length) { h1('What we need from you'); bullets(model.toProceed); }
  if (model.sourcesCited?.length) { h1('Sources'); bullets(model.sourcesCited, C.muted); }

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('sans').fontSize(8).fillColor(C.muted)
      .text(`${model.firmName} — discovery report v${model.version} — confidential`, 64, doc.page.height - 44, { width: W / 2 + 60, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, 64, doc.page.height - 44, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
