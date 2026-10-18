# Between Frames

A local physics sandbox for PhysicsCrossExam. Set the launch, place circular obstacles, and add an unfamiliar force. A small estimator receives virtual camera images and public geometry, freezes a prediction, and updates that prediction when later images disagree. An adversarial search can find scenes that expose its weaknesses.

**[Try the demo](https://matasvai.github.io/between-frames/)** · **[Source code](https://github.com/matasvai/between-frames)**

For a quick tour, choose **Bumper course** or **Vortex arena**, click **Run scene**, then **Play**. The dashed path is the first prediction, the dotted path is the updated prediction, and the solid path is actual motion. After changing the launch or physics controls, click **Run scene** to apply them. The timeline slider scrubs the completed simulation; it does not change the physics. **Train ×12** updates the small model; **Test unseen** compares it on fresh seeds.

Everything runs on your computer in the browser: no account, GPU, server-side model or API key is required. This is a toy physics estimator and bounded adversarial search, not a pretrained neural network.

Open **standalone.html** directly in a browser; it bundles the application and requires no installation or network. The editable version consists of `index.html`, `style.css`, `app.js`, and `engine.js`. To serve it locally from this directory:

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Visit `http://127.0.0.1:8766`.

## Using the sandbox

1. Set the initial position, speed and heading. Optional launch jitter varies the position between seeded trials.
2. Add circular obstacles or enable the closed arena. The circles are physical colliders, not decorations.
3. Optionally enable quadratic drag or an attraction, repulsion or vortex field. The simulator uses these forces; the small predictor does not know their coefficients.
4. Run and replay the trial. The solid motion can be revealed separately from the model's frozen and updated forecasts.
5. Search for a harder scene, train on fresh trials, then test on unseen seeds. Parameter training is intentionally limited: complex geometry produces motion updates but does not update the isolated-wall material fit.

For the original missed-impact experiment, use no obstacles or nonlinear force, aim toward the fixed right wall, and leave a blackout around contact. Reducing roughness, bounce randomness, pixel noise, packet loss and exposure separates learning an unseen bounce from handling measurement error and newly randomized impacts.

The forecast always freezes at 0.46 seconds. Moving the start near a collider or increasing launch speed can cause a collision before that time. `preImpactForecast` distinguishes that case; the demo must not call every forecast a prediction made before the first impact.

## Physics and starting conditions

The moving body is a disk on a two-dimensional plane. Its default launch is `(0.26, 0.59)` metres, at `1.35 m/s`, with heading `0°` pointing right. World coordinates use positive Y upward. Heading `90°` points upward. With zero launch jitter, these values are exact. Nonzero `launchJitter` samples a starting position uniformly within a disk of that radius, in metres; it does not perturb velocity.

The fixed right wall is at `x = 1.6 m`; the moving disk radius is `0.055 m`. The camera covers `1.8 × 1.2 m`. Enabling the closed arena adds the left, top and bottom walls. With those boundaries disabled, the body can leave the camera's view. Up to twelve static circles can be added. Starting overlaps, overlapping obstacles and an unsafe launch-jitter envelope produce actionable validation errors instead of silently relocating the body.

Between contacts, the simulator evolves:

```text
position' = velocity
velocity' = -k velocity - q |velocity| velocity + localized_field(position)
```

Here `k` is linear drag and `q` is quadratic drag. The localized field is a smooth, softened radial attraction/repulsion or a tangential vortex, with Gaussian spatial falloff. Its acceleration magnitude is bounded by the selected strength; there is no inverse-distance singularity. A vortex can inject kinetic energy. That is separate from the contact response, which is dissipative.

Each collision decomposes velocity into a local normal and tangent. The normal component reverses and is scaled by restitution; the tangent retains 96% of its magnitude. Restitution can vary around the chosen mean, and the effective contact normal can have bounded random angular variation. Any resulting component directed back into the geometric surface is removed dissipatively. Collision events report incoming/outgoing states and their kinetic-energy ratio.

Motion under linear drag uses exact free-flight propagation and swept circle/plane intersection. Nonlinear scenes use small fixed steps with field kicks and a frozen-speed approximation for quadratic drag; swept contact tests within each step prevent the disk from simply crossing a collider between samples. Tests check representative nonpenetration and high-speed thin-obstacle cases. This is a toy numerical model, without a solver-convergence claim, spin, deformation, moving obstacles or disk–disk interactions.

## What the small model knows

The predictor knows the camera calibration, disk radius, fixed wall, optional arena boundaries and obstacle circles. It receives public geometry as calibration, not by learning the map from the camera. It estimates the object's state from observed pixels and rolls that estimate forward through the known geometry using its current linear drag and effective restitution. It actually predicts circle and wall reflections.

The predictor has no representation for quadratic drag or the localized field. Enabling those terms deliberately creates model mismatch. A recent motion update can improve a short-term prediction without identifying the underlying force. Its sensitivity envelope does not include a validated bound on this mismatch.

For an isolated right-wall scene, enough incoming and outgoing trajectory observations can identify an effective bounce even if no image contains contact:

```text
effective restitution ≈ - outgoing horizontal velocity / incoming horizontal velocity
```

The fitter searches for a wall-consistent velocity reversal and fits linear drag to the two segments. It rejects inadequate residuals. Under rough contact, the horizontal ratio is an effective parameter and does not uniquely identify the simulator's microscopic normal coefficient. A low residual is also not proof that the true force law is linear: an unrepresented force can sometimes be approximated by an effective linear fit over a short interval.

Parameter fitting abstains when public geometry includes obstacles or the closed arena. Those scenes still get a later velocity-based forecast when a stable recent camera track disagrees with the frozen rollout. This is a conservative implementation boundary, not a claim that multi-contact identification is impossible. Nonlinear force coefficients are never learned.

Learning uses completed observed trials to update parameters for later trials. Each within-trial corrected forecast uses only the image prefix available at its correction time and remains separate from the original forecast. Fresh hidden impact randomness is not supplied to the learner.

## Information boundary and virtual camera

```text
Scenario settings → private simulated world → camera renderer
                                                   ↓
                                     timestamp + 96 × 64 raster
                                                   ↓
Public static geometry → detector → estimator → collision-aware forecast

Private world → evaluator and optional viewer reveal only
```

`inferCameraFrames(frames, student, calibration)` decodes the rasters itself. It ignores supplied detections and other frame metadata. Calibration is whitelisted to obstacle circles and the arena-boundary flag. Initial state, seed, true velocities, contact times, restitution, drag and force coefficients are not passed into the inference logic. The frontend can display truth for replay and scoring without changing this input boundary.

The camera creates actual grayscale pixel buffers. Static circular obstacles are dark; the moving disk is bright. The detector is a thresholded intensity centroid. Noise, trailing-exposure blur, random packet loss and blackouts around any actual contact degrade the images. The simulator chooses blackout centers; the learner does not receive those centers. Shutter integration uses only past states, and the packet timestamp marks exposure completion, leaving an uncompensated centroid lag.

This simplified camera does not establish robustness to textured scenes, real occlusion, lens distortion, rolling shutter or lighting changes. Obstacle geometry is already calibrated. The simulation is not estimating a scene map from those dark pixels.

## Adversarial search and frame scheduling

The challenger is a bounded evolutionary search, not a trained neural generator or GAN. It scores the current predictor's frozen position error. It can vary the seed, impact randomness, roughness, image noise, losses, blackout and exposure. It keeps starting-condition settings, geometry, mean restitution and linear drag fixed. When a nonlinear term is already enabled, its coefficient may also vary within the configured limits; disabled nonlinear terms remain disabled.

Eligible scenes require at least four usable initial-prefix observations, four detections before a contact and four after it. With multiple contacts, any contact meeting that evidence requirement can qualify. With no contact, the equivalent split uses the forecast freeze time. A corrected forecast is not required. If no candidate qualifies, the UI reports that failure. Selecting a rare bad seed does not estimate expected deployment performance or prove adversarial generalization.

Uniform and predicted-contact burst schedules request exactly the same number of frames, including the shared six-request initial prefix. The burst uses only the frozen model's predicted contact time. It can waste requests inside a blackout or miss the actual event when the model is wrong. Received frames, transferred bytes and correction times can differ. Equal requested frames do not establish equal energy use.

## Scores, replay and uncertainty

Frozen position RMSE starts at the later of `freeze time + 30 ms` and `first contact + 30 ms`, and ends at 2.5 seconds. If there is no collision, it starts at `freeze time + 30 ms`. The updated forecast is scored only after its own correction time. The two windows differ; the interface also reports the frozen forecast's error on the updated window for a matching comparison. JSON uses metres; the interface uses centimetres.

A correction may improve or worsen the result. Its new observations never rewrite the original forecast. The shaded envelope is heuristic model sensitivity, not a calibrated confidence interval or a nonlinear-force error bound.

Fit/search times are host JavaScript times. Image bytes count received raw grayscale buffers, excluding protocol overhead and other state. The virtual edge device is neither an Arduino emulator nor a hardware performance/memory model.

## Reproduce and inspect the evidence

No packages are required beyond Node.js for tests and Python for packaging:

```sh
node engine.test.js
node app.test.js
node evaluate.js
python3 build.py
```

The build refreshes `standalone.html` and writes `dist/between-frames-collision-lab.zip`. To share an offline copy, download the repository as a ZIP, extract it and open `standalone.html`. The GitHub Pages workflow runs both test suites before publishing the web version on each push to `main`.

The engine tests cover seeded physics, dissipative contacts, causal exposure, inference from pixels, future-information isolation, exact request budgets, learning, custom launches, overlap validation, circle contacts, multiple bounces, finite no-collision forecasts, nonlinear effects and abstention. Application tests use a DOM double and do not render a browser.

`evidence.json` records the source hash, protocol, individual trials and limitations. The main protocol trains on twenty episodes and tests on forty fresh seeds. Clean launches use `0.02 m` position jitter so the noiseless episodes actually vary. Default stochastic trials retain the fixed launch and vary impact and camera randomness. The interface uses shorter twelve/sixteen-trial runs.

Measured examples from the current source:

| Synthetic test | Initial mean frozen RMSE | Fitted mean frozen RMSE |
| --- | ---: | ---: |
| Clean varied launches; 250 ms blackout; 40 tests | 9.13 cm | 0.092 cm |
| Default stochastic impacts and camera; 40 tests | 16.33 cm | 13.44 cm |

The extension fixtures transfer the clean isolated-wall fit to twelve new launches per scene, without fitting parameters in the new scenes:

| Extension fixture | Initial mean frozen RMSE | Transferred mean frozen RMSE |
| --- | ---: | ---: |
| Known circular bumper | 15.55 cm | 0.34 cm |
| Closed arena with several contacts | 24.00 cm | 1.37 cm |
| Unrepresented vortex and quadratic drag | 38.67 cm | 43.59 cm |

All twelve arena trials had a collision before the forecast freeze, so that row is not evidence of predicting the first collision in advance. The nonlinear fixture becomes worse with the transferred linear fit; learning the simple scene does not equip the predictor to model the new force. These are small synthetic examples with no confidence intervals, independent dataset, solver-convergence study or hardware validation.

A thirty-six-candidate search in the recorded default scene selected 74.22 cm error from a 5.86 cm baseline for that seed, with seven candidates rejected. This is a selected-case failure demonstration, not a held-out average.

Tests validate engine and application logic, not rendered browser appearance. A simulator-data animation generated by `render_preview.py` is an illustration, not browser validation; older generated previews should be rebuilt when scene behavior changes.

## Connecting real hardware

Start with one marked object, a calibrated fixed camera and known geometry. Replace the synthetic frame producer with timestamped camera frames while preserving the observation boundary. A Pi/camera stage could send calibrated positions and timestamps to a smaller board. Geometry calibration, frame rate, synchronization, memory use, latency and accuracy require measurements on the actual hardware.

This demo includes no live camera capture, serial transport, microphone processing, firmware or physical deployment.

## Research connection

[IRIS (2026), contact-model discussion and future work](https://arxiv.org/html/2603.16432v2) identifies limitations of continuous coupling for brief interactions and motivates contact-focused models. This sandbox turns that motivation into controllable collision and sensor-budget experiments. It does not reproduce IRIS's learned latent pipeline or establish novelty of contact-aware identification.

## Files

| File | Purpose |
| --- | --- |
| `engine.js` | Physics, geometry, raster camera, estimator, learning and search |
| `index.html`, `style.css`, `app.js` | Editable interface |
| `standalone.html` | Bundled offline application |
| `engine.test.js`, `app.test.js` | Engine and application logic checks |
| `evaluate.js`, `evidence.json` | Reproducible synthetic evaluation |
| `build.py` | Offline application and source packaging |
| `render_preview.py` | Optional simulator-data animation; requires Pillow |
