import { describe, expect, it } from 'vitest';
import { matchesTarget, normalizeUrl, parseKeywords, parseTarget } from '../../core/target-matcher';

describe('keyword input', () => {
  it('preserves multiword phrases, order and case while removing exact duplicates', () => {
    expect(parseKeywords(' garment efficiency, sewing line balancing\n textile testing\r\n garment efficiency, A, a,, '))
      .toEqual(['garment efficiency', 'sewing line balancing', 'textile testing', 'A', 'a']);
  });
  it('supports quoted CSV keywords, embedded commas and escaped quotes', () => {
    expect(parseKeywords('"fabric, testing", "sewing ""quality""", plain\n"fabric, testing"')).toEqual(['fabric, testing', 'sewing "quality"', 'plain']);
  });
});
describe('target matching', () => {
  it('includes child subdomains and prevents suffix and lookalike domain matches', () => {
    expect(matchesTarget('https://www.example.com/article', 'example.com', 'domain')).toBe(true);
    expect(matchesTarget('https://blog.example.com/article', 'example.com', 'domain')).toBe(true);
    for (const wrong of ['https://notexample.com', 'https://example.com.evil.test', 'https://otherexample.com'])
      expect(matchesTarget(wrong, 'example.com', 'domain')).toBe(false);
  });
  it('preserves specified subdomain boundaries', () => {
    expect(matchesTarget('https://news.example.com/post', 'blog.example.com', 'domain')).toBe(false);
    expect(matchesTarget('https://example.com/post', 'blog.example.com', 'domain')).toBe(false);
    expect(matchesTarget('https://archive.blog.example.com/post', 'blog.example.com', 'domain')).toBe(true);
  });
  it('normalizes host and fragment, but preserves path, query and protocol for exact URLs', () => {
    expect(matchesTarget('https://EXAMPLE.com/post?a=1#section', 'https://example.com/post?a=1', 'exact')).toBe(true);
    for (const wrong of ['https://example.com/post-two?a=1', 'https://example.com/post?a=2', 'http://example.com/post?a=1', 'https://blog.example.com/post?a=1'])
      expect(matchesTarget(wrong, 'https://example.com/post?a=1', 'exact')).toBe(false);
    expect(matchesTarget('https://example.com/another', 'https://example.com/post', 'both')).toBe(true);
    expect(normalizeUrl('https://Example.com.:443#fragment')).toBe('https://example.com/');
  });
  it('rejects credentialed URLs and nonweb schemes', () => {
    for (const bad of ['https://user:password@example.com', 'file:///tmp/foo', 'javascript://evil', '', 'not a domain']) {
      expect(() => parseTarget(bad)).toThrow();
      expect(matchesTarget(bad, 'example.com', 'domain')).toBe(false);
    }
  });
});
