# Third-party notices

## Shipped with the app

### Speech embedding (wake word front end)
- What: the convolutional network of Google's `speech_embedding` (TensorFlow Hub / Kaggle Models, `google/speech-embedding`, TensorFlow 1, version 1), re-exported by us to ONNX (`resources/wake/speech-embedding.onnx`) with `scripts/wake-model/export_embedding.py`. The log-mel step in front of it is our own code (`scripts/wake-model/logmel.py`, `src/main/log-mel.ts`); the re-export matches Google's original module to within 4e-5.
- Source: https://www.kaggle.com/models/google/speech-embedding (licence stated on that page: Apache License 2.0). Originally published at https://tfhub.dev/google/speech_embedding/1.
- Licence: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0. Copyright Google LLC. Modified: converted from a TensorFlow graph to ONNX, with the log-mel front end removed.

### Wake word classifier
- Our own small network (`resources/wake/hey-buildy.json`), trained by us on the speech-embedding outputs of the data listed under "Used for training only". No openWakeWord model files are shipped or used.

### Speech recognition (on-device)
- whisper-tiny.en (OpenAI Whisper, MIT licence) in the ONNX conversion from onnx-community/whisper-tiny.en (Hugging Face).

### Text to speech (on-device)
- Kokoro-82M (hexgrad/Kokoro-82M, Apache License 2.0), ONNX conversion onnx-community/Kokoro-82M-v1.0-ONNX (Apache License 2.0).

## Used for training only (not shipped)
- Kokoro-82M voices (Apache License 2.0): synthetic "Hey Buildy", near-miss and general phrases.
- Piper voices (https://huggingface.co/rhasspy/piper-voices); only voices whose MODEL_CARD states a permissive dataset licence:
  - en_US-libritts_r-medium: LibriTTS-R, CC BY 4.0 (Koizumi et al., http://www.openslr.org/141/).
  - en_GB-vctk-medium: CSTR VCTK Corpus, CC BY 4.0 (Yamagishi, Veaux, MacDonald, University of Edinburgh, https://datashare.ed.ac.uk/handle/10283/3443).
  - Evaluation only: en_US-ljspeech-medium (LJ Speech, public domain) and en_GB-cori-medium (LibriVox, public domain).
  - Piper itself (GPL-3.0) was used only as a tool on a development machine to generate audio; no Piper code ships.
- LibriSpeech ASR corpus (dev-clean), CC BY 4.0: V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015, https://www.openslr.org/12/. Used as negative (non-wake) training audio and for the false-trigger test.
- No output of online/cloud text-to-speech services was used for training.
