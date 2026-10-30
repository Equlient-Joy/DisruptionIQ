import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from './schema';

export const DOCUMENT_MAX_BYTES = 26_214_400; // 25 MB
export const DOCUMENT_MAX_PAGES = 100;
export const DOCUMENT_CHUNK_CHARS = 4000;
export const DOCUMENT_CHUNK_OVERLAP_CHARS = 400;

export interface DocumentStorage {
  saveFile(id: string, data: Uint8Array, sha256: string): Promise<void>;
  loadFile(id: string): Promise<Uint8Array | null>;
  deleteFile(id: string): Promise<void>;
}

export class PostgresDocumentStorage implements DocumentStorage {
  constructor(private db: any) {}

  async saveFile(id: string, data: Uint8Array, sha256: string): Promise<void> {
    await this.db.insert(schema.documentFiles).values({
      id,
      data: Buffer.from(data),
      sha256,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: schema.documentFiles.id,
      set: { data: Buffer.from(data), sha256 },
    });
  }

  async loadFile(id: string): Promise<Uint8Array | null> {
    const [row] = await this.db.select().from(schema.documentFiles).where(eq(schema.documentFiles.id, id));
    if (!row) return null;
    return new Uint8Array(row.data);
  }

  async deleteFile(id: string): Promise<void> {
    await this.db.delete(schema.documentFiles).where(eq(schema.documentFiles.id, id));
  }
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export async function extractPages(
  filename: string,
  data: Uint8Array
): Promise<{ pages: ExtractedPage[]; mimeType: string; source: string }> {
  if (data.byteLength > DOCUMENT_MAX_BYTES) {
    throw new Error(`Documents must be smaller than ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
    } as any);
    const pdf = await task.promise;
    try {
      if (pdf.numPages > DOCUMENT_MAX_PAGES) {
        throw new Error(`Documents must contain at most ${DOCUMENT_MAX_PAGES} pages.`);
      }
      const pages: ExtractedPage[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map(item => ('str' in item ? item.str : ''))
          .join(' ');
        pages.push({ pageNumber: i, text: pageText });
      }
      return { pages, mimeType: 'application/pdf', source: 'PDF text extraction' };
    } finally {
      await pdf.destroy();
    }
  }

  if (!/\.(txt|csv|json)$/i.test(filename)) {
    throw new Error('Upload a text PDF, TXT, CSV or JSON document. Scanned PDF fields require manual review.');
  }

  const text = new TextDecoder('utf-8').decode(data);
  const mimeType = lower.endsWith('.json')
    ? 'application/json'
    : lower.endsWith('.csv')
    ? 'text/csv'
    : 'text/plain';
  return {
    pages: [{ pageNumber: 1, text }],
    mimeType,
    source: 'Text document parsing',
  };
}

export interface DocumentChunkData {
  chunkIndex: number;
  pageNumber: number;
  charStart: number;
  charEnd: number;
  content: string;
}

export function chunkPages(pages: ExtractedPage[]): DocumentChunkData[] {
  const chunks: DocumentChunkData[] = [];
  let chunkIndex = 0;
  const step = DOCUMENT_CHUNK_CHARS - DOCUMENT_CHUNK_OVERLAP_CHARS; // 3600

  for (const page of pages) {
    const text = page.text;
    if (!text || !text.trim()) {
      continue;
    }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + DOCUMENT_CHUNK_CHARS, text.length);
      chunks.push({
        chunkIndex: chunkIndex++,
        pageNumber: page.pageNumber,
        charStart: start,
        charEnd: end,
        content: text.slice(start, end),
      });
      if (end >= text.length) break;
      start += step;
    }
  }
  return chunks;
}

export function parseDocumentFields(text: string): {
  fields: { shipmentId?: string; quantity?: number; date?: string };
  issues: string[];
  confidence: number;
  excerpt: string;
} {
  const fields: { shipmentId?: string; quantity?: number; date?: string } = {};
  const issues: string[] = [];
  const reference = text.match(/(?:shipment(?:\s*(?:id|reference))?|consignment)\s*[:#=]\s*([a-zA-Z0-9_-]+)/i);
  const quantity = text.match(/(?:quantity|qty)\s*[:#=]\s*(-?[\d,.]+)/i);
  const date = text.match(/(?:date|issued)\s*[:#=]\s*(\d{4}-\d{2}-\d{2})/i);

  if (reference) fields.shipmentId = reference[1]!;
  if (quantity) {
    const value = Number(quantity[1]!.replaceAll(',', ''));
    if (Number.isInteger(value) && value >= 0) fields.quantity = value;
    else issues.push('Extracted quantity is not a nonnegative integer');
  }
  if (date) {
    if (!isNaN(Date.parse(date[1]!))) fields.date = date[1];
    else issues.push('Document date is invalid');
  }

  if (!text.trim()) issues.push('No extractable text; scanned or empty document requires manual review');
  if (!fields.shipmentId) issues.push('Shipment reference missing or extraction uncertain');
  if (fields.quantity === undefined) issues.push('Quantity missing or extraction uncertain');
  if (!fields.date) issues.push('Document date missing or extraction uncertain');

  const confidence = !text.trim()
    ? 0
    : (Number(!!fields.shipmentId) + Number(fields.quantity !== undefined) + Number(!!fields.date)) / 3 * 0.9;

  const excerpt = text.slice(0, 500);
  return { fields, issues, confidence, excerpt };
}

export async function extractDocument(file: File): Promise<{ filename: string; text: string; source: string }> {
  if (file.size > DOCUMENT_MAX_BYTES) {
    throw new Error(`Documents must be smaller than ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const { pages, source } = await extractPages(file.name, buffer);
  return {
    filename: file.name,
    text: pages.map(p => p.text).join('\n'),
    source,
  };
}
