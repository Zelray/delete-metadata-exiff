/**
 * The ONE home for exif tag-family facts (issue #22, arch-review Candidate 8).
 *
 * Before this module, the family table existed twice — `GROUP_FAMILY_ACCEPT`
 * in writePipeline and `GROUP_TO_BASE` in scrub — and `matchesTagKey` lived
 * inside the write pipeline (which never even called it), forcing readback to
 * import it back through a deliberate ESM cycle. A new tag family had to land
 * in both hand-maintained tables or AI-scrub detection and write verification
 * would disagree. Now: one table, one matcher, and the base-group lookup is
 * DERIVED from the table, so the two facts cannot drift apart.
 *
 * Small, pure, policy-free — the sibling of exifPath.ts (leaf 1.8 did the
 * same for path keys). Consumers: writePipeline, readback, scrub, gpsStrip.
 */

/**
 * Family-1 groups a written tag may legitimately appear under when read back.
 * Writing `EXIF:Software` surfaces as `IFD0:Software` in a `-G1` read, etc.
 */
const GROUP_FAMILY_ACCEPT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  exif: Object.freeze(['exif', 'ifd0', 'exififd', 'gps', 'interopifd', 'subifd']),
  png: Object.freeze(['png']),
  iptc: Object.freeze(['iptc']),
  'xmp-dc': Object.freeze(['xmp-dc']),
  'xmp-xmp': Object.freeze(['xmp-xmp']),
  'xmp-photoshop': Object.freeze(['xmp-photoshop']),
  'xmp-mwg-rs': Object.freeze(['xmp-mwg-rs']),
});

/** The inverse of the family table, built once: member group -> base family. */
const GROUP_TO_BASE: ReadonlyMap<string, string> = new Map(
  Object.entries(GROUP_FAMILY_ACCEPT).flatMap(([base, members]) =>
    members.map((member) => [member, base] as const),
  ),
);

/** True when `actualKey` (a -G1 read key) can be the requested tag. */
export function matchesTagKey(actualKey: string, requestedTag: string): boolean {
  const colonIndex = requestedTag.indexOf(':');
  const reqGroup = (colonIndex > 0 ? requestedTag.slice(0, colonIndex) : '').toLowerCase();
  const reqName = (requestedTag.split(':').pop() ?? '').toLowerCase();
  const actualColon = actualKey.indexOf(':');
  const actualGroup = (actualColon > 0 ? actualKey.slice(0, actualColon) : '').toLowerCase();
  const actualName = (actualColon > 0 ? actualKey.slice(actualColon + 1) : actualKey).toLowerCase();
  if (actualName !== reqName) return false;
  if (reqGroup === '') return true;
  const accept = GROUP_FAMILY_ACCEPT[reqGroup] ?? Object.freeze([reqGroup]);
  return accept.includes(actualGroup);
}

/**
 * The wipe-tag group base a detected read group belongs to: a detected
 * `IFD0:Software` must map to the `EXIF:Software` wipe tag, not to
 * `PNG:Software`. DERIVED from GROUP_FAMILY_ACCEPT — an unknown group is its
 * own base (the exact-match fallback), so detection and verification always
 * consult the same family knowledge.
 */
export function groupFamilyBase(group: string): string {
  return GROUP_TO_BASE.get(group.toLowerCase()) ?? group.toLowerCase();
}
