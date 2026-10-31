import { describe, expect, test } from 'bun:test';
import { mapEntityToPage } from '../src/client/components/ai-copilot';

describe('AI Copilot Client Navigation & Deep Link Handling', () => {
  test('mapEntityToPage maps all recognized domain entity types to their respective views', () => {
    expect(mapEntityToPage('incidents')).toBe('incidents');
    expect(mapEntityToPage('incident')).toBe('incidents');
    expect(mapEntityToPage('orders')).toBe('overview');
    expect(mapEntityToPage('order')).toBe('overview');
    expect(mapEntityToPage('shipments')).toBe('inventory');
    expect(mapEntityToPage('shipment')).toBe('inventory');
    expect(mapEntityToPage('lots')).toBe('inventory');
    expect(mapEntityToPage('lot')).toBe('inventory');
    expect(mapEntityToPage('warehouses')).toBe('network');
    expect(mapEntityToPage('warehouse')).toBe('network');
    expect(mapEntityToPage('suppliers')).toBe('network');
    expect(mapEntityToPage('supplier')).toBe('network');
    expect(mapEntityToPage('plans')).toBe('recovery');
    expect(mapEntityToPage('plan')).toBe('recovery');
    expect(mapEntityToPage('tasks')).toBe('collaboration');
    expect(mapEntityToPage('task')).toBe('collaboration');
    expect(mapEntityToPage('events')).toBe('evidence');
    expect(mapEntityToPage('documents')).toBe('evidence');
    expect(mapEntityToPage('history')).toBe('history');
  });

  test('deep link regex matches app:// formatted URIs', () => {
    const linkRegex = /\[([^\]]+)\]\((app:\/\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)|https?:\/\/[^\s)]+)\)/g;
    const sample = 'Please inspect [INC-101](app://incidents/INC-101) and [ORD-102](app://orders/ORD-102).';

    const matches: { label: string; type: string; id: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(sample)) !== null) {
      matches.push({
        label: match[1],
        type: match[3],
        id: match[4],
      });
    }

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ label: 'INC-101', type: 'incidents', id: 'INC-101' });
    expect(matches[1]).toEqual({ label: 'ORD-102', type: 'orders', id: 'ORD-102' });
  });
});
