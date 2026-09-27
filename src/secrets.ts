/**
 * How a rotated secret is kept in the environment, for the apps that read it
 * and `fg-dist env rotate`, which writes it.
 *
 * A secret is never read back once it is set: on Vercel it is a sensitive
 * variable, which only a deployment can see. So rotating it cannot keep the
 * old value by reading it and writing it next to the new one. Instead it has
 * two slots, `NAME_A` and `NAME_B`, and `NAME_CURRENT` — a letter, and no
 * secret — says which is in use. Rotating writes a new value into the other
 * slot, over the one from two rotations ago, and points at it. The app signs
 * and sends with the current slot, and accepts both: what was sealed or begun
 * with the one before goes on working until the next rotation.
 *
 * A plain `NAME` is a secret set by hand — several values, newest first, if it
 * is being rotated by hand. Alongside the slots it is still accepted after
 * them: the value from before rotating began, which the next rotation removes.
 *
 * Imported by the apps, so it keeps to nothing but itself.
 */

export const SLOTS = ['A', 'B'] as const
export type Slot = (typeof SLOTS)[number]

export const slotVariable = (name: string, slot: Slot): string => `${name}_${slot}`
export const pointerVariable = (name: string): string => `${name}_CURRENT`
export const otherSlot = (slot: Slot): Slot => (slot === 'A' ? 'B' : 'A')

const values = (value: string | undefined): string[] =>
  (value ?? '').split(/[\s,]+/).filter(Boolean)

/**
 * A secret's values, newest first: the one to sign and send with, then every
 * one still accepted.
 */
export const secretValues = (
  name: string,
  source: Record<string, string | undefined> = process.env
): string[] => {
  const pointer = source[pointerVariable(name)]?.trim()
  const plain = values(source[name])
  if (pointer !== 'A' && pointer !== 'B') return plain
  const current = source[slotVariable(name, pointer)]?.trim()
  const previous = source[slotVariable(name, otherSlot(pointer))]?.trim()
  return [...new Set([current, previous, ...plain].filter((value): value is string => Boolean(value)))]
}
