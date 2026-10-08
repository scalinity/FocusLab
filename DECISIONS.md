# Decisions

Deviations from the kickoff spec and choices it left open, each with its reason.
Specs state the current design; this file is where the reasons live.

## Platform

- **three 0.186.1 (r186), pinned exactly**, with vite 8.3.4, vitest 5.0.3, typescript 7.0.2.
  r186 has the APIs this app depends on: `RenderPipeline` with `outputColorTransform`, MRT
  passes, compute with storage buffers and atomics, compute-written indirect draws, timestamp
  queries, `GaussianSplat`.
- **The app requests its own adapter and device** (`src/gpu/device.ts`) with every adapter
  feature and every limit at the adapter's best value, and hands the device to
  `WebGPURenderer`. three.js cannot be told to skip its WebGL2 fallback, so it is never allowed
  to pick a device; `backend.isWebGPUBackend` is asserted after `init()`.
- **Device loss is recovered by the app.** three only reports it. `main.ts` tears down and
  rebuilds every GPU resource from scratch; optics state lives in the store and survives.
- **Dev server on localhost:5190**, strict port (5173 is used by another local project).
- **Nothing depends on `subgroups`** (Safari 27 lacks it). Workgroup memory does reductions.

## Optics model

- **Focus is carried as k = 1/f − 1/s_i** (dioptres). Blur, depth of field and the exact path's
  frustum shear are written in k, so infinity focus is k = 0 and Lab mode's past-infinity travel
  is k < 0 with no special cases.
- **Depth of field is solved as the roots of |c(d)| = c₀** in 1/d. It is algebraically identical
  to the textbook s_o·H′/(H′ ± (s_o − f)) for real focus (tested), and remains valid at infinity
  focus and past it.
- **f-numbers use the marked 1/3-stop values** (f/1.4 … f/22) in every calculation, so the
  formula panel's arithmetic matches the dial. They differ from the exact √2^(n/3) series by
  under 3%.
- **Close focus is set by a maximum magnification of 0.2** for every lens, which puts it at 6f
  (0.3 m at 50 mm, 0.81 m at 135 mm). A lens swap holds the focus distance, clamped to the new
  lens's close focus; past infinity it holds s_i/f instead.
- **Lab mode allows travel to 5% of f inside the infinity stop.** At 50 mm f/2 the sky then
  blurs by ≈1.25 mm (≈67 px at 1920), enough to see that nothing can be in focus.
- **Both stops rubber-band** with a reach of 1% of f, and the band is real travel: the render,
  the bench and the readouts all follow the same s_i.
- **The focus spring is critically damped with ω = 40 rad/s**, integrated in closed form (frame-
  rate independent): 95% of a step in 118 ms, no overshoot.
- **All distances are lens-referenced**, including the engraved scale. Real lenses reference the
  sensor plane (⊖), which adds s_i: 6 cm at the 50 mm close focus.
- **Bladed apertures are area-equivalent to the circle of diameter A**, the way f-numbers are
  calibrated, so blade count never changes exposure.

## Composition

- **Camera on a low tripod, lens ≈0.45 m above the ground.** At eye height a level 50 mm lens sees
  no ground nearer than 6.7 m, and at 0.35 m the frame is only ±7 cm tall, so the near heroes
  could not be in frame.
- **The viewfinder shows a fixed 3:2 frame** fitted inside its panel, so the render width is
  exactly the 36 mm sensor width at every window size and pixel blur = c/36 mm × width holds
  literally.

## Spec refinements adopted (proposed before building)

- Depth strip on a dioptre axis (1/d) labelled in metres, not log: ∞ is a finite point, blur is
  linear in 1/d (so the DoF band is a fixed-width window), and past-infinity focus shows as
  negative dioptres.
- Bench object side drawn under a projective compression (d, y) → (d/(d+D₀), G·y/(d+D₀)): rays
  stay straight and intersections exact while ∞ lands on a finite line. Explicit scale break at
  the lens.
- Bokeh orientation flips across focus (sign of k − 1/d); live kernels and the sensor inset
  rotate the aperture shape by the sign of the CoC, as the exact path does by construction.
- Spherical aberration is calibrated per physical zone height, so it falls as 1/N² when stopping
  down. An under-corrected singlet gives soap-bubble rims on foreground bokeh only.
- Cat's-eye vignetting comes from a second stop (the barrel's front opening), tested per pixel
  per aperture sample in the accumulate pass.
- Exposure uses the image-side f-number s_i/A, so close focus shows the bellows factor.
- The plane-of-focus contour is the zero crossing of (1/d − k) between neighbouring pixels.
- Splats build on three r186's WebGPU `GaussianSplat`; Spark 2.3.1 is WebGL2-only.
