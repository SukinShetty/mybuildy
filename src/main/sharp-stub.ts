// sharp-stub.ts — stands in for `sharp` in the voice worker's bundle
// (electron.vite.config.ts). @huggingface/transformers imports sharp for image
// models; Buildy's voice never touches images, so no image binaries ship.
export default {}
