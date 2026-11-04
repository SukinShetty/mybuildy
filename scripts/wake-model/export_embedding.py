# Re-export Google's speech_embedding (TF Hub google/speech_embedding/1, Apache-2.0) to ONNX.
# Only the convolutional network is exported (input: log-mel [batch, frames, 32, 1]);
# the log-mel step is our own code (logmel.py here, src/main/log-mel.ts in the app), checked
# against Google's graph below.  Run with TensorFlow + tf2onnx (dev machine only):
#   python export_embedding.py MODULE_DIR OUT.onnx
import sys, numpy as np, tensorflow as tf, tf2onnx, onnxruntime as ort
from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2
sys.path.insert(0, __import__('os').path.dirname(__file__)); from logmel import logmel
mod, out = sys.argv[1], sys.argv[2]
full = convert_variables_to_constants_v2(tf.saved_model.load(mod, tags=[]).signatures['default'])
gd = full.graph.as_graph_def()
MEL_IN, EMB_OUT = 'embeddings_apply_default/MudpuppyLite/ExpandDims:0', 'embeddings_apply_default/MudpuppyLite/Conv_18/Conv2D:0'
def net(mel):
    o, m = tf.compat.v1.import_graph_def(gd, input_map={MEL_IN: mel}, return_elements=[EMB_OUT, 'map/while/log_mel_spectrogram:0'], name='')
    return o
wrapped = tf.compat.v1.wrap_function(net, [tf.TensorSpec([None, None, 32, 1], tf.float32)])
fn = wrapped.prune(wrapped.inputs[0], wrapped.graph.get_tensor_by_name(EMB_OUT))
spec = (tf.TensorSpec([None, None, 32, 1], tf.float32, name='logmel'),)
@tf.function(input_signature=spec)
def f(logmel): return fn(logmel)
tf2onnx.convert.from_function(f, input_signature=spec, opset=17, output_path=out)
# checks: our log-mel == Google's; ONNX(our log-mel) == Google's full module (audio in)
x = (np.random.default_rng(0).standard_normal(12400 + 1280 * 20) * 0.1).astype(np.float32)
ref = full(default=tf.constant(x[None]))[next(iter(full.structured_outputs))].numpy() if False else full(tf.constant(x[None]))
ref = (ref[0] if isinstance(ref, (list, tuple)) else list(ref.values())[0] if isinstance(ref, dict) else ref).numpy()
s = ort.InferenceSession(out)
got = s.run(None, {s.get_inputs()[0].name: logmel(x)[None, :, :, None]})[0]
print('ref', ref.shape, 'onnx', got.shape, 'max abs diff', float(np.abs(ref.squeeze() - got.squeeze()).max()), 'max |ref|', float(np.abs(ref).max()))
