// Clustered markers for react-leaflet, on leaflet.markercluster.
//
// This replaced the react-leaflet-cluster package. That package ships as
// CommonJS with `exports.default`, and the bundler handed the page the module
// wrapper instead of the component: React threw "element type is invalid" and
// the Sites → Map tab showed the error screen. These few lines are the whole
// of what it did for us, written as an ES module so there is nothing to
// interoperate with.
import L from 'leaflet'
import 'leaflet.markercluster'
import { createElementObject, createPathComponent, extendContext } from '@react-leaflet/core'

function createClusterGroup({ children: _children, ...props }, context) {
  const options = {}
  const events = {}
  for (const [name, value] of Object.entries(props)) {
    // onClick → clusterclick, as the cluster layer names its own events.
    if (name.startsWith('on')) events[`cluster${name.slice(2).toLowerCase()}`] = value
    else options[name] = value
  }
  const group = new L.MarkerClusterGroup(options)
  for (const [event, handler] of Object.entries(events)) group.on(event, handler)
  return createElementObject(group, extendContext(context, { layerContainer: group }))
}

const MarkerClusterGroup = createPathComponent(createClusterGroup)

export default MarkerClusterGroup
