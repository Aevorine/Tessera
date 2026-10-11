/** Extract text from markup without ever creating markup through replacements.
 * This is plain-text extraction, not an HTML sanitizer. Unclosed tags are dropped.
 */
export function stripMarkupTags(value: string): string {
  const result: string[] = []
  let inTag = false
  for (const character of value) {
    if (character === '<') {
      inTag = true
    } else if (character === '>') {
      inTag = false
    } else if (!inTag) {
      result.push(character)
    }
  }
  return result.join('')
}
