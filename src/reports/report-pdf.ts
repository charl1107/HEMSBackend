import PDFDocument from 'pdfkit';

export interface ReportPdfEventMeta {
  title: string;
  status: string;
  eventDate: Date | string;
  venue: string;
  eventType: string | null;
  description: string | null;
}

export interface ReportPdfStats {
  registered: number;
  present: number;
  absent: number;
  missing: number;
  absentees: number;
  presentRate: number;
  absentRate: number;
}

export interface ReportPdfParticipantTypeCount {
  type: string;
  count: number;
}

export interface ReportPdfAbsentee {
  name: string;
  type: string;
  email: string | null;
  reason: string;
}

export interface ReportPdfTaskStats {
  total: number;
  done: number;
  completionRate: number;
}

export interface ReportPdfInput {
  event: ReportPdfEventMeta;
  stats: ReportPdfStats;
  participantTypes: ReportPdfParticipantTypeCount[];
  absentees: ReportPdfAbsentee[];
  tasks: ReportPdfTaskStats;
  absenteeDefinition: string;
  generatedAt: Date;
}

function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function buildEventReportPdf(input: ReportPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Post-Event Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).text(input.event.title);
    doc.moveDown(0.3);

    doc.fontSize(11);
    doc.text(`Status: ${input.event.status}`);
    doc.text(`Date: ${formatDate(input.event.eventDate)}`);
    doc.text(`Venue: ${input.event.venue}`);
    doc.text(`Type: ${input.event.eventType ?? 'Uncategorized'}`);
    if (input.event.description) {
      doc.text(`Description: ${input.event.description}`);
    }
    doc.text(`Generated: ${input.generatedAt.toISOString()}`);
    doc.moveDown();

    doc.fontSize(13).text('Participant Summary');
    doc.fontSize(11);
    doc.text(`Registered: ${input.stats.registered}`);
    for (const row of input.participantTypes) {
      doc.text(`  ${row.type}: ${row.count}`);
    }
    doc.moveDown();

    doc.fontSize(13).text('Attendance Summary');
    doc.fontSize(11);
    doc.text(`Present: ${input.stats.present}`);
    doc.text(`Absent (recorded): ${input.stats.absent}`);
    doc.text(`No attendance record: ${input.stats.missing}`);
    doc.text(`Present rate: ${formatPercent(input.stats.presentRate)}`);
    doc.text(`Absentee rate: ${formatPercent(input.stats.absentRate)}`);
    doc.moveDown();

    doc.fontSize(13).text('Task Completion');
    doc.fontSize(11);
    doc.text(
      `Done: ${input.tasks.done} / ${input.tasks.total} (${formatPercent(input.tasks.completionRate)})`,
    );
    doc.moveDown();

    doc.fontSize(13).text(`Absentees (${input.absentees.length})`);
    doc.fontSize(9).fillColor('#444444').text(input.absenteeDefinition);
    doc.fillColor('#000000').moveDown(0.3);
    doc.fontSize(10);
    if (input.absentees.length === 0) {
      doc.text('None.');
    } else {
      for (const absentee of input.absentees) {
        doc.text(
          `- ${absentee.name} (${absentee.type}${absentee.email ? `, ${absentee.email}` : ''}) — ${absentee.reason}`,
        );
      }
    }

    doc.end();
  });
}
