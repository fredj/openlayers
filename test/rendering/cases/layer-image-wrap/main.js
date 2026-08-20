import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import ImageLayer from '../../../../src/ol/layer/Image.js';
import {get as getProjection} from '../../../../src/ol/proj.js';
import Static from '../../../../src/ol/source/ImageStatic.js';

const projection = getProjection('EPSG:4326');

new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [
    new ImageLayer({
      source: new Static({
        url: '/data/tiles/osm/5/5/12.png',
        imageExtent: projection.getExtent(),
        projection: projection,
        wrapX: true,
      }),
    }),
  ],
  view: new View({
    projection: projection,
    center: [180, 0],
    resolution: 2.8125,
    multiWorld: true,
  }),
});

render({
  message:
    'static image is repeated across the antimeridian when wrapX is true',
});
