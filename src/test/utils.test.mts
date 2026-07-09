import { describe, it, expect } from 'vitest';
import { isPalindrome } from '../utils.mts';

describe('isPalindrome', () => {
  it('returns true for a simple palindrome word', () => {
    expect(isPalindrome('racecar')).toBe(true);
  });

  it('returns true for another palindrome word', () => {
    expect(isPalindrome('level')).toBe(true);
  });

  it('returns true for a palindrome with mixed case', () => {
    expect(isPalindrome('RaceCar')).toBe(true);
  });

  it('returns true for a palindrome with spaces and punctuation', () => {
    expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true);
  });

  it('returns true for a single character', () => {
    expect(isPalindrome('a')).toBe(true);
  });

  it('returns true for an empty string', () => {
    expect(isPalindrome('')).toBe(true);
  });

  it('returns false for a non-palindrome word', () => {
    expect(isPalindrome('hello')).toBe(false);
  });

  it('returns false for a string that is almost a palindrome', () => {
    expect(isPalindrome('racecars')).toBe(false);
  });

  it('handles numeric strings', () => {
    expect(isPalindrome('12321')).toBe(true);
  });

  it('handles numeric non-palindrome', () => {
    expect(isPalindrome('12345')).toBe(false);
  });
});
