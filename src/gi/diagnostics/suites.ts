import { bdptDiagnosticSuite } from "@/gi/bdpt/diagnostics";
import { bdptExecutionSuite } from "@/gi/bdpt/execution-diagnostics";
import type { DiagnosticSuite } from "@/gi/diagnostics/runner";

const core: DiagnosticSuite = {
  id: "core",
  label: "Core WebGPU",
  version: 1,
  description:
    "Compilation passed or failed independently of rendering correctness and performance.",
  probes: (
    [
      ["storage-write", "output[id.x] = vec4f(f32(id.x));"],
      [
        "dynamic-array",
        "var values: array<vec4f, 32>; for (var i = 0u; i < 32u; i++) { values[i] = vec4f(f32(i + id.x)); } output[id.x] = values[id.x % 32u];",
      ],
      [
        "nested-struct-array",
        "var paths: array<Path, 2>; for (var p = 0u; p < 2u; p++) { for (var i = 0u; i < 32u; i++) { paths[p].vertices[i] = vec4f(f32(id.x + i + p)); } } output[id.x] = paths[id.x % 2u].vertices[id.x % 32u];",
      ],
    ] as const
  ).map(([label, body]) => ({
    label,
    code: `struct Path { vertices: array<vec4f, 32> }
@group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) { ${body} }`,
    bindings: [[{ binding: 0, buffer: { type: "storage" } }]],
  })),
};

export const diagnosticSuites = [
  core,
  bdptDiagnosticSuite,
  bdptExecutionSuite,
] as const;
