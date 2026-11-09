let classifier;

export function isBlocked(predictions) {
  const scores = new Map(predictions.map(({className, probability}) => [className, probability]));
  return (scores.get('Porn') || 0) + (scores.get('Hentai') || 0) >= 0.65 ||
    (scores.get('Sexy') || 0) >= 0.85;
}

export async function shouldBlockPhoto(image) {
  classifier ??= import('./filter-model.js').then(({loadClassifier}) => loadClassifier()).catch(error => {
    classifier = null;
    throw error;
  });
  const model = await classifier;
  return isBlocked(await model.classify(image, 5));
}
