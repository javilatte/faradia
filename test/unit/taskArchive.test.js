'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const archive = require('../../server/store/taskArchive');

const DAY = 24 * 60 * 60 * 1000;

test('finished tasks are archived with their outcome, newest first, without transient state', (t) => {
  const repo = mkTmpDir('archive');
  t.after(() => rmTmpDir(repo));
  const now = new Date('2026-11-18T12:00:00Z');
  archive.archiveTask(
    repo,
    {
      id: 'a',
      title: 'PR task',
      pr: { url: 'https://x/pull/1', title: 'feat: x' },
      worktreePath: '/w',
      sessionId: 's'
    },
    now
  );
  archive.archiveTask(
    repo,
    { id: 'b', title: 'Merged', mergedInto: 'main', lastCommit: 'abc1234' },
    new Date(now.getTime() + 1000)
  );
  archive.archiveTask(
    repo,
    { id: 'c', title: 'Commit only', lastCommit: 'def5678', deliveredAs: 'commit' },
    new Date(now.getTime() + 2000)
  );
  archive.archiveTask(repo, { id: 'd', title: 'Never mind' }, new Date(now.getTime() + 3000));
  const list = archive.listArchive(repo, 0);
  assert.deepEqual(
    list.map((x) => [x.id, x.outcome]),
    [
      ['d', 'discarded'],
      ['c', 'commit'],
      ['b', 'merged'],
      ['a', 'pr']
    ]
  );
  assert.equal(list[3].worktreePath, undefined);
  assert.equal(list[3].sessionId, undefined);
  archive.archiveTask(repo, { id: 'd', title: 'Never mind, again' }, new Date(now.getTime() + 4000));
  assert.equal(archive.listArchive(repo, 0).length, 4, 'archiving again replaces the entry');
});

test('the archive forgets tasks older than the retention; never keeps them all', (t) => {
  const repo = mkTmpDir('archive-retention');
  t.after(() => rmTmpDir(repo));
  const now = Date.parse('2026-11-18T12:00:00Z');
  archive.archiveTask(repo, { id: 'old', title: 'old' }, new Date(now - 20 * DAY));
  archive.archiveTask(repo, { id: 'week', title: 'week' }, new Date(now - 5 * DAY));
  archive.archiveTask(repo, { id: 'today', title: 'today' }, new Date(now - 60 * 1000));
  assert.equal(archive.listArchive(repo, 0, now).length, 3);
  assert.deepEqual(
    archive.listArchive(repo, 7, now).map((x) => x.id),
    ['today', 'week']
  );
  assert.deepEqual(
    archive.listArchive(repo, 1, now).map((x) => x.id),
    ['today']
  );
  assert.equal(archive.validRetention(3), 30, 'unknown values fall back to a month');
  assert.ok(archive.removeArchived(repo, 'today'));
  assert.equal(archive.removeArchived(repo, 'today'), false);
});
