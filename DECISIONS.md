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

## Layout and composition

- **One full-window 3D scene instead of the split screen**, in the design language of DESIGN.md:
  an orbitable optical bench on the forest floor, glass UI cards over it, and the viewfinder as
  a 3:2 card at the bottom that switches to full screen. The bench and the viewfinder are two
  cameras on one world: the bench camera orbits, the viewfinder camera is the lens.
- **Object space at true scale, image space magnified ×N.** Subjects, object-side rays and the
  plane-of-focus sheet are drawn in real metres; behind the lens plane the element, iris, barrel
  and image plane are drawn ×N on the same optical axis, so a 0.2 mm blur circle becomes visible.
  Uniform scaling preserves angles and convergence inside image space; the one discontinuity is
  at the lens plane, where the scale break is labelled.
- **The viewfinder is composited, never textured onto a 3D surface**, so its pixels are exact and
  pixel blur = c/36 mm × render width holds literally. The image plane inside the bench shows the
  same render as a texture, upside down.
- **The viewfinder is a fixed 3:2 frame**, so its render width is exactly the 36 mm sensor width.
- **Camera on a low tripod, lens ≈0.45 m above the ground.** At eye height a level 50 mm lens sees
  no ground nearer than 6.7 m, and at 0.35 m the frame is only ±7 cm tall, so the near heroes
  could not be in frame.
- **Rear-focusing bench.** The lens stays where the tripod holds it and the focus ring drives the
  image-plane carriage along the rail. This is optically identical to moving the glass (only s_i
  matters), keeps every distance lens-referenced and keeps the viewfinder camera fixed in the
  world.
- **Image-space magnification is ×8, reduced for long lenses** (×6.6 at 135 mm) so the magnified
  barrel clears the ground under the 0.45 m axis. The sensor is therefore 288 × 192 mm on the bench
  for every lens up to 85 mm; the lens-plane label always shows the current ×N.
- **The bench camera keeps its orbit angle across lens swaps** and rescales its distance with the
  magnified camera's length, so 24 mm and 135 mm both stay framed.
- **The cut line needs a measurable gradient.** A surface lying exactly on the plane of focus has
  1/d − k ≈ 0 everywhere and no crossing, so it shows the sheet's grid instead of glowing.
- **Bloom threshold 1.6** (linear): only HDR rays and highlights bloom, never sunlit paper.
- **AgX tone mapping for now**, chosen by eye on the test cards for its gentle highlight rolloff
  on the rays; re-judged against Khronos PBR Neutral on the forest in M4.
- **Fonts are bundled locally** (Outfit and DM Mono, both OFL) so the app loads nothing from
  outside localhost.
- **Visual verification runs in Google Chrome only** (the harness).

## Spec refinements adopted (proposed before building)

- The distance slider is a dioptre axis (1/d) labelled in metres, with the subjects marked on
  it: ∞ is a finite point, blur is linear in 1/d (so the sharp-zone band has constant width for a
  given lens and f-number), and past-infinity focus shows as negative dioptres.
- Bokeh orientation flips across focus. An aperture point a moves the image point by
  a·s_i·(1/d − k) on the (inverted) sensor and by a·s_i·(k − 1/d) in the displayed photo, so
  in the photo far-field bokeh is the aperture upright and near-field bokeh is it rotated 180°.
  Aperture rotation is defined in the camera frame, which makes it the far-field bokeh shape.
  Live kernels and the sensor inset rotate the shape by the sign of the CoC, as the exact path
  does by construction.
- Spherical aberration is calibrated per physical zone height, so it falls as 1/N² when stopping
  down. An under-corrected singlet gives soap-bubble rims on foreground bokeh only.
- Cat's-eye vignetting comes from a second stop (the barrel's front opening), tested per pixel
  per aperture sample in the accumulate pass.
- Exposure uses the image-side f-number s_i/A, so close focus shows the bellows factor.
- The plane-of-focus contour is the zero crossing of (1/d − k) between neighbouring pixels.
- Splats build on three r186's WebGPU `GaussianSplat`; Spark 2.3.1 is WebGL2-only.

## Exact exposure (M2)

- **Sampling:** aperture positions are a Fibonacci lattice for the exposure's sample count,
  mapped area-uniformly onto the iris (angle from the R(φ)² distribution, radius R(φ)·√u); on a
  circular iris that is Vogel's sunflower. They are taken in bit-reversed order, so every
  power-of-two prefix is a coarser copy of the set and the image is presentable at any count
  (the tiers, 128/256/512, are powers of two). Sub-pixel jitter is Halton(3,5): bit-reversed
  order is the base-2 radical inverse and would correlate with Halton base 2.
- **Why not R2 for the aperture:** a point source shows the sample set itself wherever its blur
  is wider than the samples are apart. R2 is a rank-1 lattice and at 256 points one family of
  its lines is widely spaced: the largest gap on the disc is 2.30 equal-area cells, against 1.33
  for the Fibonacci lattice (`sampling.test.ts`). Dew bokeh showed R2's lines as pinwheel arms.
- **Aperture cells:** each sample stands for a cell of the aperture, so each pass is blurred by
  that cell's share of the blur, radius 1.5·|c|/(2√N) (1.5 equal-area cells, past the lattice's
  largest gap), up to 8 px: a 24-tap gather turned every pass, where a sample spreads over
  farther surfaces and over nearer ones only within their own cell. It is zero on the plane of
  focus and vanishes as N grows, so the exposure converges to the same integral; at 256 samples
  it closes the gaps between a dew drop's 256 images into a smooth disc. M2 discs: 11.17–11.53 px
  (circle), 11.50 (pentagon), 11.40 (hexagon).
- **Accumulation** is a compute pass adding each sample into an `array<vec4<f32>>` storage
  buffer (the first sample assigns instead of adding, so no clear pass); float32 blending and
  filtering are never used. A resolve pass divides by the count and crossfades from the live
  frame between 16 and 32 samples.
- **Samples per frame** follow the GPU time of the last exposing frame: count × (12 ms budget ÷
  frame GPU time), at most 48 per frame. 512 samples at 1920×1280 develop in 2.97 s in the forest.
- **GPU time is the span the GPU spent finishing a frame**: from when its work could start (the
  frame's start, or the previous frame's completion if the GPU was still busy) to
  `queue.onSubmittedWorkDone()`; the queue completes in order. Timestamp queries are not used:
  on Apple's tile-based GPUs consecutive passes overlap, and three's per-frame sum of pass
  durations counted the same time about three times over (40 ms reported for frames arriving
  14 ms apart). With the sums, the sample controller under-filled frames (512 samples took
  4.23 s) and the render scale controller saw permanent overload.
- **The bench is rendered into its own target and re-rendered only when it changes**, so an
  exposing frame costs its samples plus two composites. Once the photo develops, the bench
  re-renders once so the image plane shows the photograph.
- **Orbiting the bench does not cancel an exposure.** It changes nothing in the photograph; every
  change to optics, aperture, render size or visibility does cancel it.
- **Point-target acceptance world** (`?world=points`): beads with a constant angular size of
  about 3.5 px. A sub-pixel emitter only lands on pixel centres by chance and comes out as
  speckle. The disc is measured by energy (total ÷ interior level), which is exact for any
  emitter that leaves a flat interior. Pentagon orientation is measured with the 5th complex
  moment, because a 5-fold symmetric shape has no skew.
- **Device-loss check:** the loss is handled asynchronously, so until the handler runs the
  harness still sees the destroyed device and the first start's `ready`; the check waits for a
  device that differs from the destroyed one.
- Exposure is a fixed multiplier until the exposure chain lands with the forest (M4). Scene
  time and shadow maps must freeze while exposing once the world animates.

## Live depth of field (M3)

- **Structure:** MRT scene pass (HDR colour + axial view-space depth) → half-res prefilter into
  three fields → compute tiles of the largest near blur, dilated → far gather, near
  gather → alpha-weighted 3×3 fill → highlight scatter (compute append, indirect
  aperture-polygon sprites) → full-res composite → FXAA. DoF runs on linear HDR before any
  tone mapping; the viewfinder card tone-maps last.
- **Field separation at the downsample.** Each half-res texel keeps the far, near and in-focus
  parts of its 2×2 block as separate premultiplied colours with coverage (split smoothly by each
  sample's CoC between 1 and 4 px). Averaging a block across an in-focus edge lends the edge's
  colour to the background blur (a measured dark fringe of 9% over the blur radius before
  this), and partial near texels now give partial alpha, i.e. coverage-correct soft edges.
- **Each field's CoC is luminance-weighted**: it sets how far the field's energy spreads, so it
  follows the surface the energy comes from. A plain average of a bead against the sky
  describes neither surface (it scattered highlights at twice their size).
- **No MSAA in the scene pass; FXAA instead.** A resolved depth averages surfaces across a
  silhouette, which gave edge pixels a blur belonging to neither surface. FXAA runs on a log
  encoding (log₂(1 + c)/16) because it detects edges by luma contrast and needs perceptually
  spaced values; log keeps half-float precision over 16 stops.
- **Every CoC and coverage read is point-sampled.** Bilinear taps blend a texel's CoC with its
  neighbours' (a near bead and far sky average to no blur), which broke both the reach test
  and the highlight split.
- **Far gather:** a farther sample's blur is limited to the centre's own (it cannot spread over
  something nearer), and a nearer far-field sample blurs less than the centre, so nothing
  reaches past the centre's own blur: the far gather samples within that radius, not a tile
  maximum. Sampling a tile's largest blur left a slightly defocused subject in front of a
  heavily blurred background almost unsampled (~0.5 of 64 samples on a 9 px mushroom cap
  against a 128 px background), which showed as black specks and seams on tile boundaries.
  **Near gather:** never limited, so it samples the dilated tile radius; alpha = Σ
  coverage·weight · R²/n.
- **Background behind near objects:** at near-field centres the far pass estimates what lies
  farther than the centre (far and in-focus fields plus clearly less-blurred near samples),
  so foreground blur composites over what a lens sees past its edge, not over its own sharp
  image.
- **Gather sampling:** 64 of a 256-point R2 pool, each pixel reading its own window (shape kept,
  structured undersampling turned into fine noise), then an alpha-weighted 3×3 fill.
- **Highlights:** a blurred field texel (blur ≥ 4 px) is a highlight when its luminance is above
  1.5 and twice its surroundings', measured on a 16-tap circle of 12 full-res px around it,
  about the gather's sample spacing at its largest kernel. Everything above the surroundings'
  level is scattered as a sprite; the gather keeps only that level, so no light is counted
  twice. A highlight much brighter than its surroundings left in the gather shows the kernel's
  sample pattern (dew bokeh came out as pinwheels); a uniformly bright region (open sky) sees
  itself on the circle and stays in the gather. Cost in the forest: +1.5 ms full-screen while
  pulling focus. Sprite intensity is energy ÷ area of the area-equivalent disc.
- **Kernel cap:** 32 half-res px = 64 full-res px radius (a 128 px blur circle). Beyond that the
  live view understates blur; the exact exposure has no cap.
- **Temporal stabilisation is deferred to M4**, where the first moving content (wind) arrives;
  with a static tripod and static test scenes there is nothing to stabilise, and focus pulls
  change every pixel each frame (history would only ghost).
- **three r186 behaviours relied on or worked around:** an MRT output named `depth` is used as
  the fragment depth (the axial-depth attachment is named `viewZ`); a `NodeMaterial` with a
  `fragmentNode` ignores MRT (the prefilter uses a material-level `mrtNode`); MRT attachments
  can carry their own clear colour (`viewZ` clears to 65504, i.e. infinitely far).
- **Acceptance (`npm run check -- m3points|m3halo|m3perf`, Apple M1 Pro, Chrome 154):** live vs
  exact blur size ×0.949–1.038 on highlights (far and near, circular and pentagonal) and
  ×1.03–1.08 on gathered edges; bokeh orientation matches in both fields; halo deviation 3.1%
  (sharp over blur) and 2.5% (blur over sharp) of edge contrast at the 5 px scale. Live frame
  interval on the test cards: 8.3 ms still, 12.2 ms while pulling focus with the bench, 15.4 ms
  full-screen at 1794 px while pulling focus. The forest will need the adaptive render scale.

## Forest (M4)

- **Light:** the `river_walk_1` HDRI is rotated so its sun stands 20° left of the view axis
  at 8.6° elevation (backlit). Its sun is clipped to 6 in the image-based lighting and carried
  by a directional light (intensity 5) with three cascaded shadow maps out to 180 m, so the
  sun casts shadows and the sky does not light everything from every angle.
- **A gap in the canopy for the sun:** at 8.6° the sun's ray from the foreground climbs 0.15 m
  per metre, so crowns up to ~130 m away shade it. Trees within a crown's reach (9 m × scale)
  of that ray, short of where it clears the treetops (22 m × scale), are not placed. Without
  the gap the whole foreground sat in canopy shade and read as overcast; with it the
  foreground is sunlit and the 3 m trunk throws its shadow towards the camera.
- **Translucency is part of the sun's direct light** (`MeshSSSNodeMaterial`, configured in
  `translucency.ts`), so tissue in shadow does not glow. Glow is gated by −N·L of the visible
  face. Shadows on translucent materials are looked up 3 cm towards the sun
  (`receivedShadowPositionNode`): the shadow map's normal offset alone would put the lookup on
  a leaf's shaded face behind the leaf. Thick caps still shadow their own centre, so only rims
  and gills glow.
- **Composed foreground** (`heroes.ts`), for the low tripod: mushrooms on a mossy log at
  0.35 m, a dewy fern frond at 0.8 m (dew: mirror-smooth spheres whose sun glints become
  bokeh), wood anemones around 1.7 m, a mossy trunk whose near face is at 3 m, a fallen log at
  7.2 m. These are the world's subjects for the bench and the presets. Mushrooms and the trunk
  are procedural (no CC0 mushroom model exists); lathe profiles run bottom to top so faces
  point outwards.
- **Undergrowth:** the `fern_02` model holds four variants on a 1 m grid; each is instanced
  (688 instances), scattered on a jittered grid whose cells grow with distance, masked by noise
  into clumps, kept to a wedge wider than the 24 mm view, clear of the composed foreground and
  the trunks. Ferns farther than 20 m cast no shadow (their shadows are too small to see, and
  cost their triangles once more per cascade). They stay instanced, not batched: nearly all lie
  in the view, so per-fern culling only turns 4 draws into ~700.
- **Trees:** ez-tree geometry (vendored at `dcf309b`, MIT) for oak, ash and aspen presets,
  meshed at three detail levels from one skeleton each; the tripod never moves, so each tree's
  level is fixed by its distance. They are three `BatchedMesh`es (branches, near leaves, far
  billboard leaves that cast no shadow), culled per tree against whichever camera renders them:
  an instanced mesh spanning the forest is never culled, and the trees were 9.5 M of the frame's
  12.4 M triangles across the viewfinder and three shadow cascades. Measured A/B: full-screen
  GPU time 19.3–19.8 → 17.6 ms, with the bench 24–25 → 20.7 ms; frame triangles 12.4 M → 5.5 M.
- **Adaptive internal render scale** (§10): the live viewfinder and the bench render at a scale
  of 0.5–1 (the photograph always at native size; the resolve samples the live frame by UV).
  GPU time ∝ pixels ∝ scale², so a frame over the 13 ms budget drops the scale at once to
  what should fit; it climbs 0.05 at a time after 20 measurements in a row with room for the
  step. A fixed render width (tests) is never scaled.
- **Frame time (open):** in the forest the scale settles at 0.5 and the GPU still spends
  ~17.5 ms per full-screen frame and ~21 ms with the bench while focus is pulling (CPU ~3–5 ms;
  `npm run check -- m3perf`, M1 Pro, Chrome 154; the same build varies by up to a third
  between runs after long GPU load, so changes are measured as back-to-back A/B). Removing parts
  of the forest: without trees 14.9 ms, without the undergrowth 18.0, without shadows 20.8 (no
  saving). With the scale held fixed the full-screen frame interval is 17.4 ms at 0.5, 23.5 at
  0.75 and 28.9 at 1, i.e. about 13.6 ms + 15.3 ms × scale²: the scale controller is right to
  sit at 0.5, and the 13.6 ms that does not scale is the next target. Removing the finish's bloom
  or the highlight sprites does not change it. The display refreshes at 120 Hz, so intervals
  come in multiples of 8.3 ms: a frame needing 9–16 ms of GPU time shows as 16.7 ms. A per-pass
  breakdown is still missing (three's per-pass timestamps overcount on this GPU, see M2).
