import {ready, setBackend} from '@tensorflow/tfjs';
import {load} from 'nsfwjs/core';
import {MobileNetV2Model} from 'nsfwjs/models/mobilenet_v2';

export async function loadClassifier() {
  await setBackend('cpu');
  await ready();
  return load('MobileNetV2', {modelDefinitions: [MobileNetV2Model]});
}
