import { describe, expect, it } from 'vitest';
import { checkReadPath } from '../src/mcp/tools/readPage.js';

describe('projo_read_page – Pfadprüfung', () => {
  it('lässt normale Lese-Pfade durch', () => {
    expect(checkReadPath('/app/dates/today')).toBe('/app/dates/today');
    expect(checkReadPath(`${process.env.PROJO_BASE_URL}/app/absences?month=2026-03-01`)).toBe('/app/absences?month=2026-03-01');
  });

  it.each([
    '/logout',
    '/login',
    '/auth/entra_id',
    '/admin/zip_of_bill_pdfs/1',
    '/user/settings/2001/change_to_absence_list_and_redirect',
    '/app/dates/2026-03-10/filter_treaty?filtered_treaty_id=1',
    '/app/bookings/1/update_task?task_id=2',
    '/cable',
  ])('sperrt %s', (path) => {
    expect(() => checkReadPath(path)).toThrowError(expect.objectContaining({ code: 'blocked' }));
  });

  it('weist fremde Hosts und relative Pfade ab', () => {
    expect(() => checkReadPath('https://evil.example/app')).toThrowError(expect.objectContaining({ code: 'blocked' }));
    expect(() => checkReadPath('app/dates/today')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => checkReadPath('//evil.example/x')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  });
});
