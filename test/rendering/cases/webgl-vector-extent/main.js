/**
 * WebGL vector layers (polygons and strokes) get clipped to their extent.
 */

import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import GeoJSON from '../../../../src/ol/format/GeoJSON.js';
import TileLayer from '../../../../src/ol/layer/Tile.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import {transformExtent} from '../../../../src/ol/proj.js';
import VectorSource from '../../../../src/ol/source/Vector.js';
import XYZ from '../../../../src/ol/source/XYZ.js';

const vector = new WebGLVectorLayer({
  source: new VectorSource({
    url: '/data/countries.json',
    format: new GeoJSON(),
  }),
  style: {
    'fill-color': '#ddd',
    'stroke-color': '#eee',
    'stroke-width': 2,
  },
  extent: transformExtent([-180, -30, 0, 90], 'EPSG:4326', 'EPSG:3857'),
});

const raster = new TileLayer({
  source: new XYZ({
    url: '/data/tiles/satellite/{z}/{x}/{y}.jpg',
    transition: 0,
  }),
});

new Map({
  layers: [raster, vector],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 1,
  }),
});

render({
  message: 'WebGL vector polygons and strokes are clipped to the layer extent',
});
