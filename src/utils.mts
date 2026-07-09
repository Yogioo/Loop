/**
 * Check if a string is a palindrome.
 *
 * A palindrome is a string that reads the same forwards and backwards,
 * ignoring case and non-alphanumeric characters.
 *
 * @param str - The string to check
 * @returns true if the string is a palindrome, false otherwise
 */
export function isPalindrome(str: string): boolean {
  // Normalize: lowercase and remove non-alphanumeric characters
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Compare with its reverse
  return cleaned === cleaned.split('').reverse().join('');
}
