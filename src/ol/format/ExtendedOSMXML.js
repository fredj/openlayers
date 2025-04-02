import Feature from 'ol/Feature';
import {extend} from 'ol/array';
import {transformGeometryWithOptions} from 'ol/format/Feature';
import XMLFeature from 'ol/format/XMLFeature';
import LineString from 'ol/geom/LineString';
import MultiLineString from 'ol/geom/MultiLineString';
import MultiPoint from 'ol/geom/MultiPoint';
import MultiPolygon from 'ol/geom/MultiPolygon';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import {isEmpty} from 'ol/obj';
import {get as getProjection} from 'ol/proj';
import {
  createElementNS,
  makeChildAppender,
  makeStructureNS,
  pushParseAndPop,
  pushSerializeAndPop,
} from 'ol/xml';

/**
 * @const
 * @type {Array<null>}
 */
const NAMESPACE_URIS = [null];

/**
 * @const
 * @type {Object<string, Object<string, import("ol/xml.js").Parser>>}
 */
const WAY_PARSERS = makeStructureNS(NAMESPACE_URIS, {
  'nd': readNd,
  'tag': readTag,
});

/**
 * @const
 * @type {Object<string, Object<string, import("ol/xml.js").Parser>>}
 */
const RELATION_PARSERS = makeStructureNS(NAMESPACE_URIS, {
  'member': readMember,
  'tag': readTag,
});

/**
 * @const
 * @type {Object<string, Object<string, import("ol/xml.js").Parser>>}
 */
const PARSERS = makeStructureNS(NAMESPACE_URIS, {
  'node': readNode,
  'way': readWay,
  'relation': readRelation,
});

/**
 * @const
 * @type {Object<string, Object<string, import("ol/xml.js").Serializer>>}
 */
const OSM_SERIALIZERS = makeStructureNS(NAMESPACE_URIS, {
  'node': makeChildAppender(writeNode),
  'way': makeChildAppender(writeWay),
  'relation': makeChildAppender(writeRelation),
});

/**
 * @param {*} value Value.
 * @param {Array<*>} objectStack Object stack.
 * @param {string} [nodeName] Node name.
 * @return {Node|undefined} Node.
 */
function OSM_NODE_FACTORY(value, objectStack, nodeName) {
  if (value.get('node_id')) {
    return createElementNS('', 'node');
  }
  if (value.get('way_id')) {
    return createElementNS('', 'way');
  }
  return createElementNS('', 'relation');
}

/**
 * @const
 * @type {Array<string>}
 */
const OSM_NODE_EXTRA_KEYS = ['geometry', 'type', 'node_id', 'wayRefs'];

/**
 * @const
 * @type {Array<string>}
 */
const OSM_WAY_EXTRA_KEYS = ['geometry', 'way_id', 'nodeRefs', 'relations'];

/**
 * @classdesc
 * Feature format for reading data in the
 * [OSMXML format](https://wiki.openstreetmap.org/wiki/OSM_XML).
 *
 * @api
 */
class ExtendedOSMXML extends XMLFeature {
  constructor() {
    super();

    /**
     * @type {import("ol/proj/Projection").default}
     */
    this.dataProjection = getProjection('EPSG:4326');
  }

  /**
   * @protected
   * @param {Element} node Node.
   * @param {import("ol/format/Feature").ReadOptions} [options] Options.
   * @return {Array<import("ol/Feature").default>} Features.
   * @override
   */
  readFeaturesFromNode(node, options) {
    options = this.getReadOptions(node, options);
    if (node.localName === 'osm') {
      const state = pushParseAndPop(
        {
          nodes: {},
          ways: [],
          relations: [],
          features: [],
        },
        PARSERS,
        node,
        [options],
      );

      // Attach relation info to ways
      for (const relation of state.relations) {
        for (const member of relation.members) {
          if (member.type === 'way') {
            const way = state.ways.find((w) => w.id === member.ref);
            if (way) {
              if (!way.relations) {
                way.relations = [];
              }
              way.relations.push({
                relationId: relation.id,
                role: member.role,
                tags: relation.tags,
              });
            }
          }
        }
      }

      // Track node-to-way references
      const nodeToWayRefs = {};

      // Parse nodes in ways
      for (let j = 0; j < state.ways.length; j++) {
        const values = state.ways[j];
        const flatCoordinates = values.flatCoordinates;
        const nodeRefs = values.ndrefs;
        if (!flatCoordinates.length) {
          for (let i = 0, ii = nodeRefs.length; i < ii; i++) {
            const nodeId = nodeRefs[i];
            const point = state.nodes[nodeId];
            if (point) {
              extend(flatCoordinates, point);
              if (!nodeToWayRefs[nodeId]) {
                nodeToWayRefs[nodeId] = [];
              }
              nodeToWayRefs[nodeId].push(values.id);
            } else {
              console.warn(
                `Node reference ${nodeRefs[i]} not found in state.nodes.`,
              );
            }
          }
        }
        let geometry;
        if (values.ndrefs[0] == values.ndrefs[values.ndrefs.length - 1]) {
          // closed way

          geometry = new Polygon(flatCoordinates, 'XY', [
            flatCoordinates.length,
          ]);
        } else {
          geometry = new LineString(flatCoordinates, 'XY');
        }
        transformGeometryWithOptions(geometry, false, options);
        const feature = new Feature(geometry);
        if (values.id !== undefined) {
          feature.setId(values.id);
        }
        feature.setProperties(
          {
            ...values.tags,
            nodeRefs,
            relations: values.relations,
            way_id: values.id,
          },
          true,
        );
        state.features.push(feature);
        // features should be unique
        state.features = [...new Set(state.features)];
      }

      // Update node features with way references
      for (const nodeId in nodeToWayRefs) {
        const nodeFeature = state.features.find((f) => f.getId() === nodeId);
        if (nodeFeature) {
          const wayRefs = nodeToWayRefs[nodeId];
          nodeFeature.setProperties({wayRefs: [...new Set(wayRefs)]}, true);
        }
      }

      // Handle multi-geometries for relations
      this.constructMultiGeometries(state);

      if (state.features) {
        return state.features;
      }
    }
    return [];
  }

  /**
   * Encode an array of features in the OSM format as an XML node.
   *
   * @param {Array<Feature>} features Features.
   * @param {import("ol/format/Feature").WriteOptions} [options] Options.
   * @return {Element} Node.
   * @override
   */
  writeFeaturesNode(features, options) {
    const osm = createElementNS('', 'osm');
    osm.setAttribute('generator', 'OpenLayers');
    pushSerializeAndPop(
      {node: osm},
      OSM_SERIALIZERS,
      OSM_NODE_FACTORY,
      features,
      [options],
    );

    return osm;
  }

  /**
   * Construct multi-geometries for relations
   * @param {Object} state State object containing nodes, ways, relations, and features
   */
  constructMultiGeometries(state) {
    const relationFeatures = [];

    for (const relation of state.relations) {
      const memberFeatures = [];
      const multiGeometriesNodeRefs = [];
      for (const member of relation.members) {
        const feature = state.features.find((f) => f.getId() === member.ref);
        if (feature) {
          memberFeatures.push({feature, role: member.role});
        }
      }

      if (memberFeatures.length > 0) {
        let multiGeometry;
        if (relation.tags.type === 'multipolygon') {
          const outerRings = memberFeatures
            .filter(({role}) => role === 'outer')
            .map(({feature}) => feature.getGeometry())
            .filter((geometry) => geometry instanceof Polygon);
          const outerNodeFeature = memberFeatures
            .filter(({role}) => role === 'outer')
            .map(({feature}) => feature);

          const innerRings = memberFeatures
            .filter(({role}) => role === 'inner')
            .map(({feature}) => feature.getGeometry())
            .filter((geometry) => geometry instanceof Polygon);
          const innerNodeFeature = memberFeatures
            .filter(({role}) => role === 'inner')
            .map(({feature}) => feature);
          if (outerNodeFeature.length > 0) {
            const polygonsNodeRefs = outerNodeFeature.map((feature) => {
              const coordinatesNodeRefs = [feature.get('nodeRefs')];
              innerNodeFeature.forEach((feature) => {
                coordinatesNodeRefs.push(feature.get('nodeRefs'));
              });
              return coordinatesNodeRefs;
            });
            multiGeometriesNodeRefs.push(...polygonsNodeRefs);
          }

          if (outerRings.length > 0) {
            const polygons = outerRings.map((outer) => {
              const coordinates = [outer.getCoordinates()[0]];
              innerRings.forEach((inner) => {
                coordinates.push(inner.getCoordinates()[0]);
              });
              return coordinates;
            });

            multiGeometry = new MultiPolygon(polygons);
            console.log('polygons', polygons);
            console.log('multiGeometry', multiGeometry.getCoordinates());
            console.log('polygonsNodeRefs', multiGeometriesNodeRefs);
          }
        } else if (relation.tags.type === 'multilinestring') {
          const lineStrings = memberFeatures
            .map(({feature}) => feature.getGeometry())
            .filter((geometry) => geometry instanceof LineString);
          const lineStringsNodeRefs = memberFeatures
            .map(({feature}) => feature.get('nodeRefs'))
            .flat();
          if (lineStrings.length > 0) {
            multiGeometry = new MultiLineString(
              lineStrings.map((lineString) => lineString.getCoordinates()),
            );
            multiGeometriesNodeRefs.push(lineStringsNodeRefs);
          }
        } else if (relation.tags.type === 'multipoint') {
          const points = memberFeatures
            .map(({feature}) => feature.getGeometry())
            .filter((geometry) => geometry instanceof Point);
          const pointsNodeRefs = memberFeatures
            .map(({feature}) => feature.get('nodeRefs'))
            .flat();
          if (points.length > 0) {
            multiGeometry = new MultiPoint(
              points.map((point) => point.getCoordinates()),
            );
            multiGeometriesNodeRefs.push(pointsNodeRefs);
          }
        }

        if (multiGeometry) {
          transformGeometryWithOptions(multiGeometry, false, state.options);
          const relationFeature = new Feature(multiGeometry);
          relationFeature.setId(relation.id);
          relationFeature.setProperties(
            {
              ...relation.tags,
              wayRefs: [...new Set(relation.members)],
              nodeRefs: multiGeometriesNodeRefs,
            },
            true,
          );
          relationFeatures.push(relationFeature);

          // Remove individual features
          memberFeatures.forEach(({feature}) => {
            const index = state.features.indexOf(feature);
            if (index !== -1) {
              state.features.splice(index, 1);
            }
          });
        }
      }
    }

    // Add multi-geometries to features
    state.features.push(...relationFeatures);
  }
}

/**
 * @const
 * @type {Object<string, Object<string, import("ol/xml.js").Parser>>}
 */
const NODE_PARSERS = makeStructureNS(NAMESPACE_URIS, {
  'tag': readTag,
});

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readNode(node, objectStack) {
  const options = objectStack[0];
  const state = objectStack[objectStack.length - 1];
  const id = node.getAttribute('id');
  const lon = parseFloat(node.getAttribute('lon'));
  const lat = parseFloat(node.getAttribute('lat'));

  if (!isNaN(lon) && !isNaN(lat)) {
    const coordinates = [lon, lat];
    state.nodes[id] = coordinates;

    const values = pushParseAndPop(
      {
        tags: {},
      },
      NODE_PARSERS,
      node,
      objectStack,
    );

    const geometry = new Point(coordinates);
    transformGeometryWithOptions(geometry, false, options);
    const feature = new Feature(geometry);
    if (id !== undefined) {
      feature.setId(id);
    }
    if (!isEmpty(values.tags)) {
      feature.setProperties(
        {...values.tags, type: 'single node', node_id: id},
        true,
      );
    } else {
      feature.setProperties({type: 'way node', node_id: id}, true);
    }
    state.features.push(feature);
  }
}

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readWay(node, objectStack) {
  const id = node.getAttribute('id');
  const values = pushParseAndPop(
    {
      id: id,
      ndrefs: [],
      flatCoordinates: [],
      tags: {},
    },
    WAY_PARSERS,
    node,
    objectStack,
  );
  const state = objectStack[objectStack.length - 1];
  state.ways.push(values);
}

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readNd(node, objectStack) {
  const values = objectStack[objectStack.length - 1];
  values.ndrefs.push(node.getAttribute('ref'));
  if (node.hasAttribute('lon') && node.hasAttribute('lat')) {
    values.flatCoordinates.push(parseFloat(node.getAttribute('lon')));
    values.flatCoordinates.push(parseFloat(node.getAttribute('lat')));
  }
}

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readTag(node, objectStack) {
  const values = objectStack[objectStack.length - 1];
  values.tags[node.getAttribute('k')] = node.getAttribute('v');
}

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readRelation(node, objectStack) {
  const id = node.getAttribute('id');
  const values = pushParseAndPop(
    {
      id: id,
      members: [],
      tags: {},
    },
    RELATION_PARSERS,
    node,
    objectStack,
  );
  const state = objectStack[objectStack.length - 1];
  state.relations.push(values);
}

/**
 * @param {Element} node Node.
 * @param {Array<*>} objectStack Object stack.
 */
function readMember(node, objectStack) {
  const values = objectStack[objectStack.length - 1];
  values.members.push({
    type: node.getAttribute('type'),
    ref: node.getAttribute('ref'),
    role: node.getAttribute('role'),
  });
}

/**
 * @param {Element} node Node.
 * @param {Feature} feature Feature.
 * @param {Array<*>} objectStack Object stack.
 */
function writeNode(node, feature, objectStack) {
  node.setAttribute('id', feature.get('node_id'));
  const coordinates = transformGeometryWithOptions(
    /** @type {Point} */ (feature.getGeometry()),
    true,
    objectStack[0],
  ).getCoordinates();
  node.setAttribute('lon', coordinates[0].toString());
  node.setAttribute('lat', coordinates[1].toString());
  addTags(node, feature, OSM_NODE_EXTRA_KEYS);
}

/**
 * @param {Element} node Node.
 * @param {Feature} feature Feature.
 * @param {Array<*>} objectStack Object stack.
 */
function writeWay(node, feature, objectStack) {
  node.setAttribute('id', feature.get('way_id'));
  for (const nodeRef of feature.get('nodeRefs')) {
    const nd = createElementNS('', 'nd');
    nd.setAttribute('ref', nodeRef);
    node.appendChild(nd);
  }
  addTags(node, feature, OSM_WAY_EXTRA_KEYS);
}

/**
 * @param {Element} node Node.
 * @param {Feature} feature Feature.
 * @param {Array<*>} objectStack Object stack.
 */
function writeRelation(node, feature, objectStack) {
  console.warn('writeRelation: to be implemented');
}

/**
 * @param {Element} node Node.
 * @param {Feature} feature Feature.
 * @param {Array<string>} ignore Feature properties to ignore.
 */
function addTags(node, feature, ignore) {
  for (const [key, value] of Object.entries(feature.getProperties())) {
    if (!ignore.includes(key)) {
      const tag = createElementNS('', 'tag');
      tag.setAttribute('k', key);
      tag.setAttribute('v', value);
      node.appendChild(tag);
    }
  }
}

export default ExtendedOSMXML;
