/**
 * A `vec3` occupies 12 bytes but aligns to 16, so a scalar declared after it
 * lands in the padding word. WGSL defines that layout precisely, but drivers
 * disagree about it in practice: an Adreno 830 read `Camera.forward` as the
 * bytes of `Camera.up` and rendered a black canvas, while desktop Metal and
 * SwiftShader both read it correctly — so nothing but the affected device
 * catches it. Declaring the field as `vec4` with the scalar in `w` keeps the
 * byte layout and removes the ambiguity.
 *
 * Only structs reachable from a buffer binding are checked; function-local
 * structs never cross the CPU boundary and are free to pack however they like.
 */

type Member = { readonly name: string; readonly type: string };

/** The same `?raw` source the renderer compiles, not a re-read from disk. */
const readShaders = (): string =>
  Object.values(
    import.meta.glob<string>("./*.wgsl", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).join("\n");

const parseStructs = (source: string): Map<string, readonly Member[]> => {
  const structs = new Map<string, readonly Member[]>();
  for (const match of source.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const [, name, body] = match;
    if (name === undefined || body === undefined) continue;
    const members = body
      .replace(/\/\/[^\n]*/g, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .flatMap((entry) => {
        const member = /^(\w+)\s*:\s*(.+)$/.exec(entry);
        return member?.[1] !== undefined && member[2] !== undefined
          ? [{ name: member[1], type: member[2].trim() }]
          : [];
      });
    structs.set(name, members);
  }
  return structs;
};

/** Element type of a binding, unwrapping `array<T>` / `array<T, N>`. */
const bindingTypes = (source: string): readonly string[] =>
  [
    ...source.matchAll(
      /var\s*<\s*(?:uniform|storage)[^>]*>\s*\w+\s*:\s*([^;]+);/g,
    ),
  ]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1].trim()]))
    .map((type) => /^array\s*<\s*([^,>]+)/.exec(type)?.[1]?.trim() ?? type);

/** Bound struct types plus every struct type nested inside them. */
const hostSharedStructs = (
  structs: Map<string, readonly Member[]>,
  bound: readonly string[],
): ReadonlySet<string> => {
  const reachable = new Set<string>();
  const visit = (type: string): void => {
    const members = structs.get(type);
    if (members === undefined || reachable.has(type)) return;
    reachable.add(type);
    for (const member of members) visit(member.type);
  };
  for (const type of bound) visit(type);
  return reachable;
};

const isVec3 = (type: string): boolean => /^vec3(f|i|u|\s*<)/.test(type);
const isScalar = (type: string): boolean => /^(f32|i32|u32|f16)$/.test(type);

describe("WGSL host-shared struct layout", () => {
  const source = readShaders();
  const structs = parseStructs(source);
  const shared = hostSharedStructs(structs, bindingTypes(source));

  it("finds the structs that cross the CPU boundary", () => {
    // A parser that silently matches nothing would make every assertion below
    // vacuous, so pin the ones that must be in scope.
    expect([...shared].sort()).toEqual(
      expect.arrayContaining([
        "Camera",
        "DiReservoir",
        "GiReservoir",
        "Quad",
        "Uniforms",
      ]),
    );
  });

  it("never packs a scalar into a vec3's padding word", () => {
    const offenders = [...shared].flatMap((name) => {
      const members = structs.get(name) ?? [];
      return members.flatMap((member, index) => {
        const next = members[index + 1];
        return isVec3(member.type) && next !== undefined && isScalar(next.type)
          ? [
              `${name}.${member.name} (${member.type}) → .${next.name} (${next.type})`,
            ]
          : [];
      });
    });

    expect(offenders).toEqual([]);
  });
});
