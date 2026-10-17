import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { normalizeTags, retag, validateTags, validateTagsToRemove } from '#domain/work-items/tags.ts';
import { changes } from './fixtures.ts';

describe('field changes', () => {
  it('trims the title and keeps the order the fields were given in', () => {
    const c = changes({ effort: 3, title: '  Hello  ', state: 'New' });
    assert.deepEqual(c.values, { effort: 3, title: 'Hello', state: 'New' });
    assert.deepEqual(c.names(), ['effort', 'title', 'state']);
  });

  it('rejects a blank or overlong title', () => {
    assert.deepEqual(FieldChanges.validate({ title: '   ' }), { ok: false, error: { code: 'TITLE_REQUIRED' } });
    assert.deepEqual(FieldChanges.validate({ title: 'x'.repeat(256) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'title', max: 255 } });
    assert.ok(FieldChanges.validate({ title: 'x'.repeat(255) }).ok);
  });

  it('limits priority to whole numbers from 1 to 4', () => {
    assert.deepEqual(FieldChanges.validate({ priority: 1.5 }), { ok: false, error: { code: 'NOT_AN_INTEGER', field: 'priority' } });
    assert.deepEqual(FieldChanges.validate({ priority: 5 }), { ok: false, error: { code: 'NUMBER_OUT_OF_RANGE', field: 'priority', min: 1, max: 4 } });
    assert.ok(FieldChanges.validate({ priority: null }).ok);
  });

  it('limits amounts to 0 through 1,000,000', () => {
    assert.deepEqual(FieldChanges.validate({ effort: -1 }), { ok: false, error: { code: 'NUMBER_OUT_OF_RANGE', field: 'effort', min: 0, max: 1_000_000 } });
    assert.deepEqual(FieldChanges.validate({ remainingWork: 1_000_001 }), {
      ok: false,
      error: { code: 'NUMBER_OUT_OF_RANGE', field: 'remainingWork', min: 0, max: 1_000_000 },
    });
    assert.ok(FieldChanges.validate({ completedWork: 2.5, effort: null }).ok);
  });

  it('accepts only real calendar dates', () => {
    assert.deepEqual(FieldChanges.validate({ dueDate: '2026-02-30' }), { ok: false, error: { code: 'INVALID_DATE', field: 'dueDate' } });
    assert.ok(FieldChanges.validate({ dueDate: '2026-02-28', startDate: null }).ok);
  });

  it('limits text lengths', () => {
    assert.deepEqual(FieldChanges.validate({ valueArea: 'x'.repeat(65) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'valueArea', max: 64 } });
    assert.deepEqual(FieldChanges.validate({ foundInBuild: 'x'.repeat(256) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'foundInBuild', max: 255 } });
    assert.deepEqual(FieldChanges.validate({ description: 'x'.repeat(500_001) }), {
      ok: false,
      error: { code: 'TEXT_TOO_LONG', field: 'description', max: 500_000 },
    });
  });

  it('checks parent ids are whole numbers', () => {
    assert.deepEqual(FieldChanges.validate({ parentId: 1.5 }), { ok: false, error: { code: 'NOT_AN_INTEGER', field: 'parentId' } });
    assert.equal(changes({ parentId: 7 }).parentId, 7);
    assert.equal(changes({ parentId: null }).parentId, null);
    assert.equal(changes({}).parentId, undefined);
  });

  it('can drop fields', () => {
    const c = changes({ state: 'Done', effort: 1 }).without('state');
    assert.deepEqual(c.values, { effort: 1 });
    assert.equal(c.has('state'), false);
    assert.equal(FieldChanges.none.isEmpty, true);
  });
});

describe('tags', () => {
  it('normalises tags, keeping the first spelling', () => {
    assert.deepEqual(normalizeTags(['a', 'A', ' b ', '']), ['a', 'b']);
    assert.deepEqual(changes({ tags: ['a', 'A', ' b '] }).values.tags, ['a', 'b']);
  });

  it('limits the number and length of tags', () => {
    assert.deepEqual(validateTags(Array.from({ length: 101 }, (_, i) => `t${i}`)), { ok: false, error: { code: 'TOO_MANY_TAGS', max: 100 } });
    assert.deepEqual(validateTags(['y'.repeat(101)]), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'tags', max: 100 } });
    assert.deepEqual(validateTags(['  ']), { ok: false, error: { code: 'TAG_EMPTY' } });
    assert.deepEqual(validateTagsToRemove(['y'.repeat(101)]), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'tags', max: 100 } });
    assert.deepEqual(validateTagsToRemove([' any ']), { ok: true, value: [' any '] });
  });

  it('retags, counting the tags an item already has', () => {
    assert.deepEqual(retag(['Web', 'Urgent'], ['Q3', 'web'], ['URGENT']), { ok: true, value: ['Web', 'Q3'] });
    const hundred = Array.from({ length: 100 }, (_, i) => `t${i}`);
    assert.deepEqual(retag(['Web'], hundred, []), { ok: false, error: { code: 'TOO_MANY_TAGS', max: 100 } });
    assert.equal(retag(['Web'], hundred.slice(1), []).ok, true);
  });
});
