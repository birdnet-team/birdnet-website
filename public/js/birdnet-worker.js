/* Simplified BirdNET TF.js worker (no remap, direct labels) */
importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest');

const params = new URL(self.location.href).searchParams;
const ROOT = params.get('root') || '/models';
const REQ_LANG = params.get('lang'); // optional explicit language

const BIRD_BASE = ROOT + '/birdnet';
const MODEL_PATH = BIRD_BASE + '/model.json';                 // layers model
const AREA_MODEL_PATH = BIRD_BASE + '/area-model/model.json'; // optional geo model
const LABELS_DIR = BIRD_BASE + '/labels';

main();

async function main(){
  const navigatorLang = new URL(location.href).searchParams.get('lang');
  await tf.setBackend('webgl');

  // Register custom layer if model JSON references it
  class MelSpecLayerSimple extends tf.layers.Layer {
    constructor(config){
      super(config);
      this.sampleRate = config.sampleRate;
      this.specShape = config.specShape;
      this.frameStep = config.frameStep;
      this.frameLength = config.frameLength;
      this.melFilterbank = tf.tensor2d(config.melFilterbank);
    }
    build(inputShape){
      this.magScale = this.addWeight('magnitude_scaling', [], 'float32',
        tf.initializers.constant({ value: 1.23 }));
      super.build(inputShape);
    }
    computeOutputShape(inputShape){ return [inputShape[0], this.specShape[0], this.specShape[1], 1]; }
    call(inputs){
      return tf.tidy(()=> {
        let x = inputs[0];
        return tf.stack(x.split(x.shape[0]).map(input => {
          let spec = input.squeeze();
          spec = tf.sub(spec, tf.min(spec, -1, true));
          spec = tf.div(spec, tf.max(spec, -1, true).add(1e-6));
          spec = tf.sub(spec, 0.5).mul(2.0);
          spec = tf.engine().runKernel('STFT', { signal: spec, frameLength: this.frameLength, frameStep: this.frameStep });
          spec = tf.matMul(spec, this.melFilterbank).pow(2.0);
          spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
          spec = tf.reverse(spec, -1);
          spec = tf.transpose(spec).expandDims(-1);
          return spec;
        }));
      });
    }
    static get className(){ return 'MelSpecLayerSimple'; }
  }
  tf.serialization.registerClass(MelSpecLayerSimple);

  const birdModel = await tf.loadLayersModel(MODEL_PATH, {
    onProgress: p => postMessage({ message:'load_model', progress: (p*70)|0 })
  });

  postMessage({ message:'warmup', progress:70 });
  await birdModel.predict(tf.zeros([1,144000])).dispose();

  postMessage({ message:'load_geomodel', progress:90 });
  let areaModel = null;
  try { areaModel = await tf.loadGraphModel(AREA_MODEL_PATH); } catch(e){ areaModel = null; }

  postMessage({ message:'load_labels', progress:95 });
  const supportedLanguages = ['af','da','en_us','fr','ja','no','ro','sl','tr','ar','de','es','hu','ko','pl','ru','sv','uk','cs','en_uk','fi','it','nl','pt','sk','th','zh'];
  const lang = (() => {
    if (REQ_LANG) return REQ_LANG;
    if(!navigatorLang) return 'en_us';
    const base = navigatorLang.split('-')[0];
    return supportedLanguages.find(l => l.startsWith(base)) || 'en_us';
  })();

  const birdsList     = (await fetch(LABELS_DIR + '/en_us.txt').then(r=>r.text())).split('\n');
  let birdsListI18n;
  try { birdsListI18n = (await fetch(`${LABELS_DIR}/${lang}.txt`).then(r=>r.text())).split('\n'); }
  catch { birdsListI18n = birdsList; }

  const birds = new Array(birdsList.length);
  for(let i=0;i<birdsList.length;i++){
    const base = birdsList[i] || '';
    const loc  = birdsListI18n[i] || base;
    birds[i] = {
      geoscore: 1,
      name: base.split('_')[1] || base,
      nameI18n: loc.split('_')[1] || base
    };
  }

  let lastMeans = null; // pooled scores

  postMessage({ message:'loaded' });

  onmessage = async ({ data }) => {
    if (data.message === 'predict') {
      const SAMPLE_RATE = 48000;
      const windowSize = 144000; // 3s
      const overlapSecRaw = parseFloat(data.overlapSec ?? 1.5);
      const overlapSec = Math.min(2.5, Math.max(0.0, Math.round(overlapSecRaw * 2) / 2));
      const overlapSamples = Math.round(overlapSec * SAMPLE_RATE);
      const hopSamples = Math.max(1, windowSize - overlapSamples);

      const pcm = data.pcmAudio || new Float32Array(0);
      const total = pcm.length;

      // Compute integer frame count and zero-pad last frame
      const numFrames = Math.max(1, Math.ceil(Math.max(0, total - windowSize) / hopSamples) + 1);
      const framed = new Float32Array(numFrames * windowSize);
      for (let f = 0; f < numFrames; f++) {
        const start = f * hopSamples;
        const srcEnd = Math.min(start + windowSize, total);
        framed.set(pcm.subarray(start, srcEnd), f * windowSize); // tail stays zero-padded
      }

      const audioTensor = tf.tensor2d(framed, [numFrames, windowSize]);
      const resTensor = birdModel.predict(audioTensor);
      const predictionList = await resTensor.array(); // [numFrames, numClasses]
      resTensor.dispose(); audioTensor.dispose();

      // DEBUG: top-10 per batch
      try {
        const top10PerBatch = predictionList.map((arr, b) => {
          const top = arr.map((v,i)=>({i,v})).sort((a,b)=>b.v-a.v).slice(0,10)
                        .map(({i,v}) => ({ index:i, name: birds[i].nameI18n || birds[i].name, confidence:v }));
          const max = Math.max(...arr);
          const mean = arr.reduce((a,c)=>a+c,0) / arr.length;
          return { batch:b, max, mean, top10: top };
        });
        console.group('[birdnet-worker] prediction debug');
        console.log('batches:', batches, 'windowSize:', windowSize, 'labels:', birds.length);
        top10PerBatch.forEach(({ batch, max, mean, top10 }) => {
          console.groupCollapsed(`batch ${batch} · max=${max.toFixed(4)} · mean=${mean.toExponential(2)}`);
          console.table(top10.map(t => ({ name: t.name, confidence: +t.confidence.toFixed(4) })));
          console.groupEnd();
        });
        console.groupEnd();
        postMessage({ message:'predict_debug', top10PerBatch });
      } catch {}

      // Mean pool across batches per class
      const numClasses = predictionList[0]?.length || 0;
      const sums = new Float32Array(numClasses);
      for (let b=0;b<predictionList.length;b++) {
        const row = predictionList[b];
        for (let i=0;i<numClasses;i++) sums[i] += row[i];
      }
      lastMeans = Array.from(sums, s => s / (predictionList.length || 1));

      // Build pooled records (include current geo)
      const pooled = new Array(numClasses);
      for (let i=0;i<numClasses;i++) {
        pooled[i] = {
          index: i,
          name: birds[i].name,
          nameI18n: birds[i].nameI18n,
          confidence: lastMeans[i],
          geoscore: birds[i].geoscore
        };
      }
      postMessage({ message:'pooled', pooled });
    }

    if(data.message === 'area-scores' && areaModel){
      tf.engine().startScope();
      const startOfYear = new Date(new Date().getFullYear(),0,1);
      startOfYear.setDate(startOfYear.getDate() + (1 - (startOfYear.getDay() % 7)));
      const week = Math.round((Date.now() - startOfYear.getTime()) / 604800000) + 1;
      const input = tf.tensor([[data.latitude, data.longitude, week]]);
      const areaScores = await areaModel.predict(input).data();
      tf.engine().endScope();
      for(let i=0;i<birds.length;i++){ birds[i].geoscore = areaScores[i]; }
      postMessage({ message:'area-scores' });

      // Re-emit pooled with updated geo scores if we have means
      if (lastMeans) {
        const pooled = lastMeans.map((m, i) => ({
          index: i, name: birds[i].name, nameI18n: birds[i].nameI18n,
          confidence: m, geoscore: birds[i].geoscore
        }));
        postMessage({ message:'pooled', pooled });
      }
    }
  };
}

/* STFT kernels (webgl) – fixed implementation */
tf.registerKernel({
  kernelName:'STFT',
  backendName:'webgl',
  kernelFunc:({ backend, inputs:{ signal, frameLength, frameStep } })=>{
    const innerDim = frameLength/2;
    const batch = (signal.size - frameLength + frameStep) / frameStep | 0;

    // Stage 1: windowing + bit-reverse permutation into [batch, frameLength]
    let currentTensor = backend.runWebGLProgram({
      variableNames:['x'],
      outputShape:[batch, frameLength],
      userCode:`void main(){
        ivec2 c=getOutputCoords();
        int p=c[1]%${innerDim};
        int k=0;
        for(int i=0;i<${Math.log2(innerDim)};++i){
          if((p & (1<<i))!=0){ k|=(1<<(${Math.log2(innerDim)-1}-i)); }
        }
        int i=2*k;
        if(c[1]>=${innerDim}){ i=2*(k%${innerDim})+1; }
        int q=c[0]*${frameLength}+i;
        float val=getX((q/${frameLength})*${frameStep}+ q % ${frameLength});
        float cosArg=${2.0*Math.PI/frameLength}*float(q);
        float mul=0.5-0.5*cos(cosArg);
        setOutput(val*mul);
      }`
    },[signal],'float32');

    // Stage 2: iterative FFT butterflies into [batch, innerDim * 2] (real/imag)
    for(let len=1; len<innerDim; len*=2){
      let prevTensor = currentTensor;
      currentTensor = backend.runWebGLProgram({
        variableNames:['x'],
        outputShape:[batch, innerDim*2],
        userCode:`void main(){
          ivec2 c=getOutputCoords();
          int b=c[0];
          int i=c[1];
          int k=i%${innerDim};
          int isHigh=(k%${len*2})/${len};
          int highSign=(1 - isHigh*2);
          int baseIndex=k - isHigh*${len};
          float t=${Math.PI/len}*float(k%${len});
          float a=cos(t);
          float bsin=sin(-t);
          float oddK_re=getX(b, baseIndex+${len});
          float oddK_im=getX(b, baseIndex+${len+innerDim});
          if(i<${innerDim}){
            float evenK_re=getX(b, baseIndex);
            setOutput(evenK_re + (oddK_re*a - oddK_im*bsin)*float(highSign));
          } else {
            float evenK_im=getX(b, baseIndex+${innerDim});
            setOutput(evenK_im + (oddK_re*bsin + oddK_im*a)*float(highSign));
          }
        }`
      },[prevTensor],'float32');
      backend.disposeIntermediateTensorInfo(prevTensor);
    }

    // Stage 3: reassemble real RFFT output [batch, innerDim + 1]
    const real = backend.runWebGLProgram({
      variableNames:['x'],
      outputShape:[batch, innerDim+1],
      userCode:`void main(){
        ivec2 c=getOutputCoords();
        int b=c[0];
        int i=c[1];
        int zI=i%${innerDim};
        int conjI=(${innerDim}-i)%${innerDim};
        float Zk0=getX(b,zI);
        float Zk1=getX(b,zI+${innerDim});
        float Zk_conj0=getX(b,conjI);
        float Zk_conj1=-getX(b,conjI+${innerDim});
        float t=${-2.0*Math.PI}*float(i)/float(${innerDim*2});
        float diff0=Zk0 - Zk_conj0;
        float diff1=Zk1 - Zk_conj1;
        float result=(Zk0+Zk_conj0 + cos(t)*diff1 + sin(t)*diff0)*0.5;
        setOutput(result);
      }`
    },[currentTensor],'float32');
    backend.disposeIntermediateTensorInfo(currentTensor);
    return real;
  }
});