import Feature from '../src/ol/Feature.js';
import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import Point from '../src/ol/geom/Point.js';
import WebGLVectorLayer from '../src/ol/layer/WebGLVector.js';
import VectorSource from '../src/ol/source/Vector.js';

// Three overlapping circles, one per `group`. The WebGL vector renderer
// does not yet support the `z-index` style property (see
// https://github.com/openlayers/openlayers/issues/16331): draw order
// currently follows the order of the style rules array instead. The
// style below has one rule per group, listed in the order in which the
// circles should stack: "a" is drawn first (bottom), "c" last (top).
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
      },
    },
    {
      filter: ['==', ['get', 'group'], 'b'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#CC3399',
      },
    },
    {
      filter: ['==', ['get', 'group'], 'c'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#99CC33',
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
