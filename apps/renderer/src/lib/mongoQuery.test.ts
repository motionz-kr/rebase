import { describe, it, expect } from 'vitest';
import { parseMongoCommand } from './mongoQuery';

describe('parseMongoCommand', () => {
  it('find with filter, sort, limit', () => {
    expect(parseMongoCommand('db.people.find({age: {$gt: 20}}).sort({age: -1}).limit(10)')).toEqual({
      collection: 'people', op: 'find', filter: '{"age":{"$gt":20}}', sort: '{"age":-1}', limit: 10,
    });
  });
  it('find with no args defaults to empty filter', () => {
    expect(parseMongoCommand('db.people.find()')).toEqual({ collection: 'people', op: 'find', filter: '{}' });
  });
  it('find with projection (2nd arg)', () => {
    const r = parseMongoCommand("db.users.find({active: true}, {name: 1, _id: 0})");
    expect(r).toEqual({ collection: 'users', op: 'find', filter: '{"active":true}', projection: '{"name":1,"_id":0}' });
  });
  it('aggregate', () => {
    expect(parseMongoCommand('db.orders.aggregate([{$match: {paid: true}}, {$group: {_id: "$user", n: {$sum: 1}}}])')).toEqual({
      collection: 'orders', op: 'aggregate', pipeline: '[{"$match":{"paid":true}},{"$group":{"_id":"$user","n":{"$sum":1}}}]',
    });
  });
  it('countDocuments', () => {
    expect(parseMongoCommand('db.people.countDocuments({age: {$gte: 18}})')).toEqual({
      collection: 'people', op: 'count', filter: '{"age":{"$gte":18}}',
    });
  });
  it('single-quoted strings', () => {
    expect(parseMongoCommand("db.c.find({name: 'Ann'})")).toEqual({ collection: 'c', op: 'find', filter: '{"name":"Ann"}' });
  });
  it('rejects write ops', () => {
    const r = parseMongoCommand('db.people.insertOne({x:1})');
    expect('error' in r).toBe(true);
  });
  it('rejects garbage', () => {
    expect('error' in parseMongoCommand('select * from x')).toBe(true);
  });
  it('reports bad json', () => {
    const r = parseMongoCommand('db.c.find({age: })');
    expect('error' in r).toBe(true);
  });
});
