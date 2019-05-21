const isMSIE8 = !('getComputedStyle' in window && typeof window.getComputedStyle === 'function');

function extensions(parentClass) {
  return {

    initialize: function (arg1, arg2) {
      let options;
      if (parentClass === L.GeoJSON) {
        parentClass.prototype.initialize.call(this, arg1, arg2);
        options = arg2;
      } else {
        parentClass.prototype.initialize.call(this, arg1);
        options = arg1;
      }
      this._originalLayers = [];
      this._visibleLayers = [];
      this._staticLayers = [];
      this._cachedRelativeBoxes = [];
      this._margin = options.margin || 0;
      this._rbush = null;
      this._mapLayers = {};
    },

    refresh: function () {
      for (let i = 0; i < this._visibleLayers.length; i++) {
        parentClass.prototype.removeLayer.call(this, this._visibleLayers[i]);
      }

      this._rbush = rbush();

      for (let i = 0; i < this._originalLayers.length; i++) {
        this._maybeAddLayerToRBush(this._originalLayers[i]);
      }
    },

    addLayer: function (layer) {
      this._mapLayers[layer.options.uuid] = layer;
      if (!('options' in layer) || !('icon' in layer.options)) {
        this._staticLayers.push(layer);
        parentClass.prototype.addLayer.call(this, layer);
        return;
      }

      this._originalLayers.push(layer);
      if (this._map) {
        this._maybeAddLayerToRBush(layer);
      }
    },

    removeLayer: function (layer) {
      delete this._mapLayers[layer.options.uuid];
      this._rbush.remove(this._cachedRelativeBoxes[layer._leaflet_id]);
      delete this._cachedRelativeBoxes[layer._leaflet_id];
      parentClass.prototype.removeLayer.call(this, layer);
      var i;

      i = this._originalLayers.indexOf(layer);
      if (i !== -1) { this._originalLayers.splice(i, 1); }

      i = this._visibleLayers.indexOf(layer);
      if (i !== -1) { this._visibleLayers.splice(i, 1); }

      i = this._staticLayers.indexOf(layer);
      if (i !== -1) { this._staticLayers.splice(i, 1); }
    },

    _removeLayersByBox: function (collideItems) {
      for (var i = 0; i < collideItems.length; i++) {
        const layer2Remove = this._mapLayers[collideItems[i].uuid];
        if (layer2Remove) {
          parentClass.prototype.removeLayer.call(this, layer2Remove);
        }
      }
    },

    updateLayerOptions: function (layerUUID, newOptions) {
      if (this._mapLayers[layerUUID]) {
        this._mapLayers[layerUUID].options.poi = newOptions;
      }
    },

    clearLayers: function () {
      this._rbush = rbush();
      this._originalLayers = [];
      this._visibleLayers = [];
      this._staticLayers = [];
      this._cachedRelativeBoxes = [];
      parentClass.prototype.clearLayers.call(this);
    },

    onAdd: function (map) {
      this._map = map;

      for (var i in this._staticLayers) {
        map.addLayer(this._staticLayers[i]);
      }

      this._onZoomEnd();
      map.on('zoomend', this._onZoomEnd, this);
    },

    onRemove: function (map) {
      for (var i in this._staticLayers) {
        map.removeLayer(this._staticLayers[i]);
      }
      map.off('zoomend', this._onZoomEnd, this);
      parentClass.prototype.onRemove.call(this, map);
    },

    _generateRelativeBoxes: function (layer) {
      parentClass.prototype.addLayer.call(this, layer);
      visible = true;
      var box = this._getIconBox(layer._icon, layer.options.uuid);
      var boxes = this._getRelativeBoxes(layer._icon.children, box);
      boxes.push(box);
      this._cachedRelativeBoxes[layer._leaflet_id] = boxes;
      return boxes;
    },

    _maybeAddLayerToRBush: function (layer) {
      var z = this._map.getZoom();
      var bush = this._rbush;
      var boxes = layer._leaflet_id ? this._cachedRelativeBoxes[layer._leaflet_id] : null;
      let visible = false;
      if (!boxes) {
        // Add the layer to the map so it's instantiated on the DOM, in order to fetch its position and size.
        boxes = this._generateRelativeBoxes(layer);
      }

      boxes = this._positionBoxes(this._map.latLngToLayerPoint(layer.getLatLng()), boxes);
      let collision = false;

      for (let i = 0; i < boxes.length && !collision; i++) {
        let collideItems = bush.search(boxes[i]);
        collision = collideItems.length > 0;
        if (this._mapLayers[layer.options.uuid].options.poi.highlight) {
          collision = false;
          if (collideItems.length > 0) {
            this._removeLayersByBox(collideItems);
          }
        }
      }

      if (!collision) {
        if (!visible) {
          parentClass.prototype.addLayer.call(this, layer);
        }
        this._visibleLayers.push(layer);
        bush.load(boxes);
      } else {
        parentClass.prototype.removeLayer.call(this, layer);
      }
    },

    // Returns a plain array with the relative dimensions of a L.Icon, based
    //   on the computed values from iconSize and iconAnchor.
    _getIconBox: function (el, uuid) {

      if (isMSIE8) {
        // Fallback for MSIE8, will most probably fail on edge cases
        return [0, 0, el.offsetWidth, el.offsetHeight];
      }

      const styles = window.getComputedStyle(el);
      return this._toBox(
        parseInt(styles.marginLeft),
        parseInt(styles.marginTop),
        parseInt(styles.marginLeft) + parseInt(styles.width),
        parseInt(styles.marginTop) + parseInt(styles.height),
        uuid
      );
    },

    // Much like _getIconBox, but works for positioned HTML elements, based on offsetWidth/offsetHeight.
    _getRelativeBoxes: function (els, baseBox) {
      let boxes = [];
      for (let i = 0; i < els.length; i++) {
        let el = els[i];
        if (!el.attributes['data-ignore-collision']) {
          let box = this._toBox(el.offsetLeft, el.offsetTop, el.offsetLeft + el.offsetWidth, el.offsetTop + el.offsetHeight);
          box = this._boxTransform(box, baseBox);
          boxes.push(box);
        }

        if (el.children.length) {
          var parentBox = baseBox;
          if (!isMSIE8) {
            var positionStyle = window.getComputedStyle(el).position;
            if (positionStyle === 'absolute' || positionStyle === 'relative') {
              parentBox = box;
            }
          }
          boxes = boxes.concat(this._getRelativeBoxes(el.children, parentBox));
        }
      }
      return boxes;
    },

    // Adds the coordinate of the layer (in pixels / map canvas units) to each box coordinate.
    _positionBoxes: function (offset, boxes) {
      var newBoxes = [];	// Must be careful to not overwrite references to the original ones.
      for (var i = 0; i < boxes.length; i++) {
        newBoxes.push(this._positionBox(offset, boxes[i]));
      }
      return newBoxes;
    },

    _positionBox: function (offset, box) {
      const delta = this._toBox(offset.x - this._margin, offset.y - this._margin, offset.x + this._margin, offset.y + this._margin);
      return this._boxTransform(box, delta);
    },

    _onZoomEnd: function () {
      this.refresh();
    },

    _toBox: function (minX, minY, maxX, maxY, uuid) {
      return { minX, minY, maxX, maxY, uuid };
    },

    _boxTransform: function (sourceBox, transformBox) {
      return this._toBox(sourceBox.minX + transformBox.minX,
        sourceBox.minY + transformBox.minY,
        sourceBox.maxX + transformBox.maxX,
        sourceBox.maxY + transformBox.maxY,
        sourceBox.uuid || transformBox.uuid)
    },
  }
}

L.LayerGroup.Placement = L.LayerGroup.extend(extensions(L.LayerGroup));
L.FeatureGroup.Placement = L.FeatureGroup.extend(extensions(L.FeatureGroup));
L.GeoJSON.Placement = L.GeoJSON.extend(extensions(L.GeoJSON));

L.layerGroup.placement = function (options) {
  return new L.LayerGroup.Placement(options || {});
};

L.featureGroup.placement = function (options) {
  return new L.FeatureGroup.Placement(options || {});
};

L.geoJson.placement = function (geojson, options) {
  return new L.GeoJSON.Placement(geojson, options || {});
};

