// A minimal, valid one-page PDF built from ASCII lines. Used for the
// fictional documents only; no real taxpayer data ever enters this repo.
export function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let text = 'BT\n/F1 17 Tf\n64 748 Td\n22 TL\n';
  lines.forEach((line, i) => {
    if (i === 1) text += '/F1 10.5 Tf\n16 TL\n';
    text += `(${esc(line)}) Tj T*\n`;
  });
  text += 'ET\n';
  // Ruled lines, like an analysis pad.
  let rules = '0.72 0.80 0.65 RG 0.5 w\n';
  for (let y = 560; y >= 120; y -= 22) rules += `64 ${y} m 548 ${y} l S\n`;
  const content = rules + text;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  if (/[^\x00-\x7f]/.test(out)) throw new Error('PDF lines must be ASCII');
  return new TextEncoder().encode(out);
}
