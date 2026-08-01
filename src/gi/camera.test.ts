import {
  cameraBasis,
  cameraPosition,
  DEFAULT_CAMERA,
  dollyCamera,
  MAX_PITCH,
  MAX_RADIUS,
  MIN_RADIUS,
  orbitCamera,
  primaryRayDirection,
  projectToUv,
} from "@/gi/camera";
import { add, dot, length, scale, sub } from "@/gi/math";

const ASPECT = 16 / 9;

describe("cameraBasis", () => {
  it("produces an orthonormal right-handed frame aimed at the target", () => {
    const basis = cameraBasis(DEFAULT_CAMERA, ASPECT);
    expect(length(basis.forward)).toBeCloseTo(1);
    expect(length(basis.right)).toBeCloseTo(1);
    expect(length(basis.up)).toBeCloseTo(1);
    expect(dot(basis.forward, basis.right)).toBeCloseTo(0);
    expect(dot(basis.forward, basis.up)).toBeCloseTo(0);
    expect(dot(basis.right, basis.up)).toBeCloseTo(0);

    const toTarget = sub(DEFAULT_CAMERA.target, basis.pos);
    expect(dot(basis.forward, toTarget)).toBeCloseTo(length(toTarget));
  });

  // Rays leaving the frame corners must still enter the room through its front
  // face, otherwise the cutaway shows background instead of the interior.
  it("frames the room opening at wide aspect ratios", () => {
    const eye = cameraPosition(DEFAULT_CAMERA);
    expect(eye.z).toBeGreaterThan(1);

    const basis = cameraBasis(DEFAULT_CAMERA, ASPECT);
    for (const ndcX of [-1, 1]) {
      for (const ndcY of [-1, 1]) {
        const direction = primaryRayDirection(basis, ndcX, ndcY);
        const entry = add(
          basis.pos,
          scale(direction, (1 - basis.pos.z) / direction.z),
        );
        expect(entry.x).toBeGreaterThan(0);
        expect(entry.x).toBeLessThan(1);
        expect(entry.y).toBeGreaterThan(0);
        expect(entry.y).toBeLessThan(1);
      }
    }
  });

  // A phone in portrait would otherwise see a patch of the back wall: the
  // horizontal half-extent is `tanHalfFov * aspect`, so it shrinks with the
  // viewport unless the vertical field of view opens up to compensate.
  it("keeps the horizontal extent fixed below a square viewport", () => {
    const square = cameraBasis(DEFAULT_CAMERA, 1);
    const portrait = cameraBasis(DEFAULT_CAMERA, 390 / 844);

    expect(portrait.tanHalfFov * portrait.aspect).toBeCloseTo(
      square.tanHalfFov * square.aspect,
    );
    expect(portrait.tanHalfFov).toBeGreaterThan(square.tanHalfFov);
  });

  it("leaves the vertical field of view alone on landscape viewports", () => {
    expect(cameraBasis(DEFAULT_CAMERA, ASPECT).tanHalfFov).toBeCloseTo(
      Math.tan(DEFAULT_CAMERA.fovY / 2),
    );
  });
});

// projectToUv is the temporal-reuse reprojection; it has to invert the primary
// ray generation exactly or every reused reservoir lands on the wrong pixel.
describe("primaryRayDirection / projectToUv round trip", () => {
  const cases: readonly (readonly [number, number])[] = [
    [0, 0],
    [0.3, -0.2],
    [-0.85, 0.6],
    [0.99, 0.99],
  ];

  it.each(cases)("recovers ndc (%p, %p)", (ndcX, ndcY) => {
    const basis = cameraBasis(DEFAULT_CAMERA, ASPECT);
    const direction = primaryRayDirection(basis, ndcX, ndcY);
    const point = add(basis.pos, scale(direction, 0.37));
    const projected = projectToUv(basis, point);

    expect(projected.inFrustum).toBe(true);
    expect(projected.u).toBeCloseTo(ndcX * 0.5 + 0.5, 5);
    expect(projected.v).toBeCloseTo(0.5 - ndcY * 0.5, 5);
  });

  it("reports points behind the eye as outside the frustum", () => {
    const basis = cameraBasis(DEFAULT_CAMERA, ASPECT);
    const behind = sub(basis.pos, scale(basis.forward, 0.1));
    expect(projectToUv(basis, behind).inFrustum).toBe(false);
  });
});

describe("camera controls", () => {
  it("clamps pitch to keep the eye off the poles", () => {
    const tilted = orbitCamera(DEFAULT_CAMERA, 0, 10);
    expect(tilted.pitch).toBeCloseTo(MAX_PITCH);
    expect(orbitCamera(DEFAULT_CAMERA, 0, -10).pitch).toBeCloseTo(-MAX_PITCH);
  });

  it("clamps the dolly radius to the room interior", () => {
    expect(dollyCamera(DEFAULT_CAMERA, 100).radius).toBeCloseTo(MAX_RADIUS);
    expect(dollyCamera(DEFAULT_CAMERA, 0.001).radius).toBeCloseTo(MIN_RADIUS);
  });

  it("leaves yaw unwrapped so orbiting is continuous", () => {
    expect(orbitCamera(DEFAULT_CAMERA, 1.5, 0).yaw).toBeCloseTo(
      DEFAULT_CAMERA.yaw + 1.5,
    );
  });
});
