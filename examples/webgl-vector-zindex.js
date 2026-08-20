import Feature from '../src/ol/Feature.js';
import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import Point from '../src/ol/geom/Point.js';
import WebGLVectorLayer from '../src/ol/layer/WebGLVector.js';
import VectorSource from '../src/ol/source/Vector.js';

// Three overlapping circles, one per `group`. The WebGL vector renderer
// honors the `z-index` style property, so stacking is controlled by
// `z-index` and not by the order of the style rules array: "a" is listed
// first but has the highest z-index and is drawn on top, "b" is listed
// second but has the lowest z-index and is drawn at the bottom.
const source = new VectorSource({
  features: [
    new Feature({geometry: new Point([-40000, 0]), group: 'a'}),
    new Feature({geometry: new Point([0, 0]), group: 'b'}),
    new Feature({geometry: new Point([40000, 0]), group: 'c'}),
  ],
});

const vectorLayer = new WebGLVectorLayer({
  source,
  style: [
    {
      filter: ['==', ['get', 'group'], 'a'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#3399CC',
        'z-index': 3,
        'text-value': 'a',
        'text-font': 'bold 20px sans-serif',
        'text-fill-color': '#fff',
      },
    },
    {
      filter: ['==', ['get', 'group'], 'b'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#CC3399',
        'z-index': 1,
        'text-value': 'b',
        'text-font': 'bold 20px sans-serif',
        'text-fill-color': '#fff',
      },
    },
    {
      filter: ['==', ['get', 'group'], 'c'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#99CC33',
        'z-index': 2,
        'text-value': 'c',
        'text-font': 'bold 20px sans-serif',
        'text-fill-color': '#fff',
      },
    },
  ],
});

new Map({
  layers: [vectorLayer],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 8,
  }),
});
