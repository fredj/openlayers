import Feature from '../../../../src/ol/Feature.js';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import Point from '../../../../src/ol/geom/Point.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

const source = new VectorSource({
  features: [
    new Feature({geometry: new Point([-40000, 0]), group: 'a'}),
    new Feature({geometry: new Point([0, 0]), group: 'b'}),
    new Feature({geometry: new Point([40000, 0]), group: 'c'}),
  ],
});

const vector = new WebGLVectorLayer({
  source,
  style: [
    {
      filter: ['==', ['get', 'group'], 'a'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#3399CC',
        'z-index': 3,
      },
    },
    {
      filter: ['==', ['get', 'group'], 'b'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#CC3399',
        'z-index': 1,
      },
    },
    {
      filter: ['==', ['get', 'group'], 'c'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#99CC33',
        'z-index': 2,
      },
    },
  ],
});

new Map({
  layers: [vector],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 8,
  }),
});

render({
  message:
    'Circle "a" (rule listed first, z-index 3) is drawn on top despite ' +
    'being styled by the first rule, because z-index (not rule order) now ' +
    'controls draw order in the WebGL vector renderer.',
});
