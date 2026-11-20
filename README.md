# birdnet-website
BirdNET website built with Eleventy.

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/birdnet-team/birdnet-website.git
   cd birdnet-website
   ```

2. Build and run the site locally:
   ```bash
   npm install
   npm run serve
   ```
3. Open your browser and navigate to `http://localhost:8080` to view the site.

## Browser demo

The demo page (`/demo/`) runs BirdNET V3.0, the BirdNET Geomodel and BirdBox
with [ONNX Runtime Web](https://onnxruntime.ai/) (WASM, self-hosted under
`/vendor/onnxruntime-web/`), plus the previous BirdNET V2.4 demo with
TensorFlow.js. Inference runs in a pool of web workers; nothing is uploaded.

The ONNX models are too large for this repository. `npm run build` and
`npm run serve` call `npm run fetch-models` first, which downloads them,
checks their SHA-256, derives label and species-name files, and writes
everything to `_models/` (gitignored). Eleventy publishes that folder as
`/models/`, and the deploy workflow caches it.

- BirdNET+ V3.0 Global 12K (the pruned FP16 ONNX model, 69 MB), the BirdNET+
  Geomodel V3.0.5 and the BirdNET+ Taxonomy come from the Zenodo record
  [BirdNET+ V3.0 model files](https://zenodo.org/records/24362980), version 3.0.1.
- BirdBox comes from a pinned commit of [BirdBox](https://github.com/birdnet-team/BirdBox).

To update a model, change the record or commit and the hashes in
`scripts/fetch-models.mjs`. The first build downloads about 270 MB.

The two BirdNET+ models join by BirdNET ID. The audio model has 11,709 species
and 16 non-animal sound classes; the geomodel knows 10,926 of these species.
With the location filter on, a species the geomodel lacks is hidden, except in
the groups it has no species of at all (fishes, reptiles, the one arachnid and
the sound classes), which the filter leaves alone.

Species details (photo credit, descriptions, links) come from the
[BirdNET taxonomy service](https://birdnet.cornell.edu/taxonomy/docs). Its API is
same-origin on birdnet.cornell.edu; on other hosts the demo falls back to the
build-time snapshot in `models/v3/info.json`.

### Developer check: score parity

The V3.0 tab exports CSV with the columns of the V3.0 command-line analyzer.
`scripts/dev/v3_parity.py` runs the same ONNX model with onnxruntime in Python
and compares it with such an export:

```bash
pip install onnxruntime librosa numpy
python scripts/dev/v3_parity.py public/audio/BirdNET_soundscape_32kHz.flac demo.csv
```

For the sample soundscape the rows are identical and scores differ by at most
0.0012 (WASM vs. native floating point). The sample is stored at 32 kHz, so no
resampling is involved.

The species of a BirdBox box comes from BirdNET+ V3.0 run on the box itself,
not on a fixed window: the audio of the box's time span (at least 1 s, centred
on a shorter box), with everything outside the box's frequency band replaced
by the recording's background noise (`public/js/demo/region-cut.js`), at that
length, which the model's variable input allows. The band is cut on a
short-time Fourier transform, where it ends within about 30 Hz. A filter with
a gentle slope is not enough: BirdNET still hears a bird 40 dB down, so a loud
bird just above or below a box would name the box. Silence outside the band
does not work either, as the box's own bird then scores much lower. The
five best-scoring birds become the box's candidates, and the best one its
species if it scores at least 35%. A box longer than 10 s is scored in equal
parts, and each species keeps its highest score.

Where two boxes overlap in time and frequency, both would hear the sound in
the overlap. The overlap belongs to the smaller box; that time-frequency
region is replaced by background noise in the larger box's audio in the same
step, so a box around another bird's call is not named after that bird.

BirdBox runs as a stream, a few seconds of audio at a time, in a file and
while the microphone records. `fetch-models.mjs` takes the model's two
streaming graphs out of the BirdBox model for that. The boxes are those of one
run of the whole graph in ONNX Runtime Web, bit for bit, and a recording loaded
again as a file gives the boxes found while recording. Against the graph in
Python (onnxruntime 1.27), the sample as 32 kHz WAV gives the same 56 boxes,
with confidences within 0.0005, times within 5 ms and frequencies within 40 Hz
(WASM vs. native floating point).

Other sample rates are converted by `public/js/demo/resample.js`, not by the
browser: a Kaiser-windowed sinc filter, flat to 14.6 kHz with about 100 dB
stopband from 16 kHz. It differs from librosa's default (soxr_hq) by less than
-80 dB below 12 kHz; only the 14-16 kHz transition band differs noticeably.
PCM WAV files at 32 kHz load bit-identical to `librosa.load(sr=32000, mono=True)`.
Microphone recordings go through the same filter as they arrive and are saved
as 32 kHz 16-bit WAV.
The demo analyzes at most the first 61 minutes of a recording.

## Project map data

Project entries live in `src/_data/projects.js`. Use decimal-degree coordinates and
fully qualified website/paper URLs. Local survey CSV exports must be removed after importing; they are never
published.

For an identified species photograph, set `Species Image Scientific Name` and run
`node scripts/update_project_images.js` to refresh the image URL, caption, author,
license, and source from the [BirdNET taxonomy service](https://birdnet.cornell.edu/taxonomy/docs).
Broad surveys can retain project photos or placeholders. Builds use the saved
metadata and do not contact the taxonomy API.

The Leaflet map uses OpenStreetMap standard tiles without an API token and loads
them only after map consent. Keep attribution visible and do not prefetch tiles.

## License

- **Source Code**: The source code for this project is licensed under the [MIT License](https://opensource.org/licenses/MIT).
- **Models**: The BirdNET V2.4 model in this repository is licensed under the [Creative Commons Attribution-ShareAlike 4.0 International License (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/). The BirdNET+ V3.0 audio model and the BirdNET+ Geomodel, downloaded at build time, are licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) and come with an acceptable use policy (`MODEL_LICENSE.txt` and `ACCEPTABLE_USE.txt` in the [Zenodo record](https://zenodo.org/records/24362980)).

Please ensure you review and adhere to the specific license terms provided with each model.

## Citation

Feel free to use BirdNET for your acoustic analyses and research. If you do, please cite as:

```bibtex
@article{kahl2021birdnet,
  title={BirdNET: A deep learning solution for avian diversity monitoring},
  author={Kahl, Stefan and Wood, Connor M and Eibl, Maximilian and Klinck, Holger},
  journal={Ecological Informatics},
  volume={61},
  pages={101236},
  year={2021},
  publisher={Elsevier}
}
```

## Funding

Our work in the Cornell K. Lisa Yang Center for Conservation Bioacoustics is made possible by the generosity of K. Lisa Yang to advance innovative conservation technologies to inspire and inform the conservation of wildlife and habitats.

The development of BirdNET is supported by the German Federal Ministry of Research, Technology and Space (FKZ 01|S22072), the German Federal Ministry for the Environment, Climate Action, Nature Conservation and Nuclear Safety (FKZ 67KI31040E), the German Federal Ministry of Economic Affairs and Energy (FKZ 16KN095550), the Deutsche Bundesstiftung Umwelt (project 39263/01) and the European Social Fund.

## Partners

BirdNET is a joint effort of partners from academia and industry.
Without these partnerships, this project would not have been possible.
Thank you!

![Our partners](https://tuc.cloud/index.php/s/KSdWfX5CnSRpRgQ/download/box_logos.png)



