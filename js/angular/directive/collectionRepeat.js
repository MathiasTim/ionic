
/**
 * @ngdoc directive
 * @restrict A
 * @name collectionRepeat
 * @module ionic
 * @codepen mFygh
 * @description
 * `collection-repeat` allows an app to show huge lists of items much more performantly than
 * `ng-repeat`.
 *
 * It renders into the DOM only as many items as are currently visible.
 *
 * This means that on a phone screen that can fit eight items, only the eight items matching
 * the current scroll position will be rendered.
 *
 * **The Basics**:
 *
 * - The data given to collection-repeat must be an array.
 * - If the `item-height` and `item-width` attributes are not supplied, it will be assumed that
 *   every item in the list's dimensions are the same as the first item's dimensions.
 * - Don't use angular one-time binding (`::`) with collection-repeat. The scope of each item is
 *   assigned new data and re-digested as you scroll. Bindings need to update, and one-time bindings
 *   won't.
 *
 * **Performance Tips**:
 *
 * - The iOS webview has a performance bottleneck when switching out `<img src>` attributes.
 *   To increase performance of images on iOS, cache your images in advance and,
 *   if possible, lower the number of unique images. Check out [this codepen]().
 *
 * @usage
 * #### Basic Item List (codepen)
 * ```html
 * <ion-content>
 *   <ion-item collection-repeat="item in items">
 *     {% raw %}{{item}}{% endraw %}
 *   </ion-item>
 * </ion-content>
 * ```
 *
 * #### Grid of Images (codepen)
 * ```html
 * <ion-content>
 *   <img collection-repeat="photo in photos"
 *     item-width="33%"
 *     item-height="200px"
 *     ng-src="{% raw %}{{photo.url}}{% endraw %}">
 * </ion-content>
 * ```
 *
 * #### Horizontal Scroller, Dynamic Item Width (codepen)
 * ```html
 * <ion-content direction="x">
 *   <img collection-repeat="photo in photos"
 *     item-width="getWidth(photo)"
 *     item-height="100%">
 * </ion-content>
 * ```
 *
 * @param {expression} collection-repeat The expression indicating how to enumerate a collection,
 *   of the format  `variable in expression` – where variable is the user defined loop variable
 *   and `expression` is a scope expression giving the collection to enumerate.
 *   For example: `album in artist.albums` or `album in artist.albums | orderBy:'name'`.
 * @param {expression=} item-width The width of the repeated element. The expression must return
 *   a number (pixels) or a percentage. Defaults to the width of the first item in the list.
 * @param {expression=} item-height The height of the repeated element. The expression must return
 *   a number (pixels) or a percentage. Defaults to the height of the first item in the list.
 * @param {number=} item-render-buffer The number of items to load before and after the visible
 *   items in the list. Default 10. This is good to set higher if you have lots of images to preload.
 * @param {boolean=} force-refresh-images Force images to refresh as you scroll. This fixes a problem
 *   where, when an element is interchanged as scrolling, its image will still have the old src
 *   while the new src loads. Setting this to true comes with a small performance loss.
 */

IonicModule
.directive('collectionRepeat', CollectionRepeatDirective)
.factory('$ionicCollectionManager', RepeatManagerFactory);

var ONE_PX_TRANSPARENT_IMG_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
var WIDTH_HEIGHT_REGEX = /height:.*?px;\s*width:.*?px/;
var DEFAULT_RENDER_BUFFER = 10;

CollectionRepeatDirective.$inject = ['$ionicCollectionManager', '$parse', '$window', '$$rAF'];
function CollectionRepeatDirective($ionicCollectionManager, $parse, $window, $$rAF) {
  return {
    restrict: 'A',
    priority: 1000,
    transclude: 'element',
    $$tlb: true,
    require: '^$ionicScroll',
    link: postLink
  };

  function postLink(scope, element, attr, scrollCtrl, transclude) {
    var scrollView = scrollCtrl.scrollView;
    var node = element[0];
    var containerNode = angular.element('<div class="collection-repeat-container">')[0];
    node.parentNode.replaceChild(containerNode, node);

    if (scrollView.options.scrollingX && scrollView.options.scrollingY) {
      throw new Error("collection-repeat expected a parent x or y scrollView, not " +
                      "an xy scrollView.");
    }

    var match = attr.collectionRepeat.match(/^\s*([\s\S]+?)\s+in\s+([\s\S]+?)(?:\s+track\s+by\s+([\s\S]+?))?\s*$/);
    if (!match) {
      throw new Error("collection-repeat expected expression in form of '_item_ in " +
                      "_collection_[ track by _id_]' but got '" + attr.collectionRepeat + "'.");
    }
    var keyExpr = match[1];
    var listExpr = match[2];
    var heightData = {};
    var widthData = {};
    var computedStyleDimensions = {};
    var repeatManager;

    // attr.collectionBufferSize is deprecated
    var renderBufferExpr = attr.itemRenderBuffer || attr.collectionBufferSize;
    var renderBuffer = angular.isDefined(renderBufferExpr) ?
      parseInt(renderBufferExpr) :
      DEFAULT_RENDER_BUFFER;

    // attr.collectionItemHeight is deprecated
    var heightExpr = attr.itemHeight || attr.collectionItemHeight;
    // attr.collectionItemWidth is deprecated
    var widthExpr = attr.itemWidth || attr.collectionItemWidth;

    //Height and width have four 'modes':
    //1) Computed Mode
    //  - Nothing is supplied, so we getComputedStyle() on one element in the list and use
    //    that width and height value for the width and height of every item. This is re-computed
    //    every resize.
    //2) Constant Mode, Static Integer
    //  - The user provides a constant number for width or height, in pixels. We parse it,
    //    store it on the `value` field, and it never changes
    //3) Constant Mode, Percent
    //  - The user provides a percent string for width or height. The getter for percent is
    //    stored on the `getValue()` field, and is re-evaluated once every resize. The result
    //    is stored on the `value` field.
    //4) Dynamic Mode
    //  - The user provides a dynamic expression for the width or height.  This is re-evaluated
    //    for every item, stored on the `.getValue()` field.
    if (!heightExpr && !widthExpr) {
      heightData.computed = widthData.computed = true;
    } else {
      if (heightExpr) {
        parseDimensionAttr(heightExpr, heightData);
      } else {
        heightData.computed = true;
      }
      if (!widthExpr) widthExpr = '"100%"';
      parseDimensionAttr(widthExpr, widthData);
    }

    var afterItemsContainer = angular.element(
      scrollView.__content.querySelector('.collection-repeat-after-container')
    );
    if (!afterItemsContainer.length) {
      var elementIsAfterRepeater = false;
      var afterNodes = [].filter.call(scrollView.__content.childNodes, function(node) {
        if (node.contains(containerNode)) {
          elementIsAfterRepeater = true;
          return false;
        }
        return elementIsAfterRepeater;
      });
      afterItemsContainer = angular.element('<span class="collection-repeat-after-container">');
      if (scrollView.options.scrollingX) {
        afterItemsContainer.addClass('horizontal');
      }
      afterItemsContainer.append(afterNodes);
      scrollView.__content.appendChild(afterItemsContainer[0]);
    }

    $$rAF(refreshDimensions);
    scrollCtrl.$element.one('scroll.init', refreshDimensions);

    var onWindowResize = ionic.animationFrameThrottle(validateResize);
    angular.element($window).on('resize', onWindowResize);

    scope.$on('$destroy', function() {
      angular.element($window).off('resize', onWindowResize);
      scrollCtrl.$element && scrollCtrl.$element.off('scroll.init', refreshDimensions);

      computedStyleNode && computedStyleNode.parentNode &&
        computedStyleNode.parentNode.removeChild(computedStyleNode);
      computedStyleScope && computedStyleScope.$destroy();
      computedStyleScope = computedStyleNode = null;

      repeatManager && repeatManager.destroy();
      repeatManager = null;
    });

    // Make sure this resize actually changed the size of the screen
    function validateResize() {
      var h = scrollView.__clientHeight, w = scrollView.__clientWidth;
      if (w && h && (validateResize.height !== h || validateResize.width !== w)) {
        validateResize.height = h;
        validateResize.width = w;
        refreshDimensions();
      }
    }
    function refreshDimensions() {
      if (heightData.computed || widthData.computed) {
        computeStyleDimensions();
      }

      if (heightData.computed) {
        heightData.value = computedStyleDimensions.height;
      } else if (!heightData.dynamic && heightData.getValue) {
        // If it's a constant with a getter (eg percent), we just refresh .value after resize
        heightData.value = heightData.getValue();
      }
      if (widthData.computed) {
        widthData.value = computedStyleDimensions.width;
      } else if (!widthData.dynamic && widthData.getValue) {
        // If it's a constant with a getter (eg percent), we just refresh .value after resize
        widthData.value = widthData.getValue();
      }
      // Dynamic dimensions aren't updated on resize. Since they're already dynamic anyway,
      // .getValue() will be used.

      if (!repeatManager) {
        repeatManager = new $ionicCollectionManager({
          afterItemsNode: afterItemsContainer[0],
          containerNode: containerNode,
          heightData: heightData,
          widthData: widthData,
          forceRefreshImages: !!(isDefined(attr.forceRefreshImages) && attr.forceRefreshImages !== 'false'),
          keyExpression: keyExpr,
          listExpression: listExpr,
          renderBuffer: renderBuffer,
          scope: scope,
          scrollView: scrollCtrl.scrollView,
          transclude: transclude,
        });
      }
      repeatManager.refreshLayout();
    }

    function parseDimensionAttr(attrValue, dimensionData) {
      if (!attrValue) return;

      var parsedValue;
      // Try to just parse the plain attr value
      try {
        parsedValue = $parse(attrValue);
      } catch(e) {
        // If the parse fails and the value has `px` or `%` in it, surround the attr in
        // quotes, to attempt to let the user provide a simple `attr="100%"` or `attr="100px"`
        if (attrValue.indexOf('%') !== -1 || attrValue.indexOf('px') !== -1) {
          attrValue = '"' + attrValue + '"';
        }
        parsedValue = $parse(attrValue);
      }

      dimensionData.attrValue = attrValue;

      // If it's a constant, it's either a percent or just a constant pixel number.
      if (parsedValue.constant) {
        var intValue = parseInt(parsedValue());

        // For percents, store the percent getter on .getValue()
        if (attrValue.indexOf('%') > -1) {
          var decimalValue = intValue / 100;
          dimensionData.getValue = dimensionData === heightData ?
            function() { return Math.floor(decimalValue * scrollView.__clientHeight); } :
            function() { return Math.floor(decimalValue * scrollView.__clientWidth); };
        } else {
          // For static constants, just store the static constant.
          dimensionData.value = intValue;
        }

      } else {
        dimensionData.dynamic = true;
        dimensionData.getValue = dimensionData === heightData ?
          function heightGetter(scope, locals) {
            var result = parsedValue(scope, locals);
            if (result.charAt && result.charAt(result.length - 1) === '%')
              return Math.floor(parseInt(result) / 100 * scrollView.__clientHeight);
            return parseInt(result);
          } :
          function widthGetter(scope, locals) {
            var result = parsedValue(scope, locals);
            if (result.charAt && result.charAt(result.length - 1) === '%')
              return Math.floor(parseInt(result) / 100 * scrollView.__clientWidth);
            return parseInt(result);
          };
      }
    }

    var computedStyleNode;
    var computedStyleScope;
    function computeStyleDimensions() {
      if (!computedStyleNode) {
        transclude(computedStyleScope = scope.$new(), function(clone) {
          clone[0].removeAttribute('collection-repeat'); // remove absolute position styling
          computedStyleNode = clone[0];
        });
      }
      computedStyleScope[keyExpr] = ($parse(listExpr)(scope) || [])[0];
      containerNode.appendChild(computedStyleNode);

      var style = $window.getComputedStyle(computedStyleNode);
      computedStyleDimensions.width = parseInt(style.width);
      computedStyleDimensions.height = parseInt(style.height);

      containerNode.removeChild(computedStyleNode);
    }

  }

}

RepeatManagerFactory.$inject = ['$rootScope', '$window', '$$rAF'];
function RepeatManagerFactory($rootScope, $window, $$rAF) {
  var EMPTY_DIMENSION = { primaryPos: 0, secondaryPos: 0, primarySize: 0, secondarySize: 0 };

  return function RepeatController(options) {
    var afterItemsNode = options.afterItemsNode;
    var containerNode = options.containerNode;
    var forceRefreshImages = options.forceRefreshImages;
    var heightData = options.heightData;
    var widthData = options.widthData;
    var keyExpression = options.keyExpression;
    var listExpression = options.listExpression;
    var renderBuffer = options.renderBuffer;
    var scope = options.scope;
    var scrollView = options.scrollView;
    var transclude = options.transclude;

    var data = [];

    var getterLocals = {};
    var heightFn = heightData.getValue || function() { return heightData.value; };
    var heightGetter = function(index, value) {
      getterLocals[keyExpression] = value;
      getterLocals.$index = index;
      return heightFn(scope, getterLocals);
    };

    var widthFn = widthData.getValue || function() { return widthData.value; };
    var widthGetter = function(index, value) {
      getterLocals[keyExpression] = value;
      getterLocals.$index = index;
      return widthFn(scope, getterLocals);
    };

    var isVertical = !!scrollView.options.scrollingY;

    // We say it's a grid view if we're either dynamic or not 100% width
    var isGridView = isVertical ?
      (widthData.dynamic || widthData.value !== scrollView.__clientWidth) :
      (heightData.dynamic || heightData.value !== scrollView.__clientHeight);

    var isStaticView = !heightData.dynamic && !widthData.dynamic;

    var PRIMARY = 'PRIMARY';
    var SECONDARY = 'SECONDARY';
    var TRANSLATE_TEMPLATE_STR = isVertical ?
      'translate3d(SECONDARYpx,PRIMARYpx,0)' :
      'translate3d(PRIMARYpx,SECONDARYpx,0)';
    var WIDTH_HEIGHT_TEMPLATE_STR = isVertical ?
      'height: PRIMARYpx; width: SECONDARYpx;' :
      'height: SECONDARYpx; width: PRIMARYpx;';

    var estimatedHeight;
    var estimatedWidth;

    var repeaterBeforeSize = 0;
    var repeaterAfterSize = 0;

    var renderStartIndex = -1;
    var renderEndIndex = -1;
    var renderAfterBoundary = -1;
    var renderBeforeBoundary = -1;

    var itemsPool = [];
    var itemsLeaving = [];
    var itemsEntering = [];
    var itemsShownMap = {};
    var nextItemId = 0;
    var estimatedItemsAcross;

    // view is a mix of list/grid methods + static/dynamic methods.
    // See bottom for implementations. Available methods:
    //
    // getEstimatedPrimaryPos(i), getEstimatedSecondaryPos(i), getEstimatedIndex(scrollTop),
    // calculateDimensions(toIndex), getDimensions(index),
    // updateRenderRange(scrollTop, scrollValueEnd), onRefreshLayout(), onRefreshData()
    var view = isVertical ? new VerticalViewType() : new HorizontalViewType();
    (isGridView ? GridViewType : ListViewType).call(view);
    (isStaticView ? StaticViewType : DynamicViewType).call(view);

    var isLayoutReady = false;
    var isDataReady = false;
    this.refreshLayout = function(itemsAfterRepeater) {
      estimatedHeight = heightGetter(0, data[0]);
      estimatedWidth = widthGetter(0, data[0]);

      // Get the size of every element AFTER the repeater. We have to get the margin before and
      // after the first/last element to fix a browser bug with getComputedStyle() not counting
      // the first/last child's margins into height.
      var style = getComputedStyle(afterItemsNode);
      var firstStyle = getComputedStyle(afterItemsNode.firstElementChild);
      var lastStyle = getComputedStyle(afterItemsNode.lastElementChild);
      repeaterAfterSize = (parseInt(style[isVertical ? 'height' : 'width']) || 0) +
        (firstStyle && parseInt(firstStyle[isVertical ? 'marginTop' : 'marginLeft']) || 0) +
        (lastStyle && parseInt(lastStyle[isVertical ? 'marginBottom' : 'marginRight']) || 0);

      // Get the offsetTop of the repeater.
      repeaterBeforeSize = 0;
      var current = containerNode;
      do {
        repeaterBeforeSize += current[isVertical ? 'offsetTop' : 'offsetLeft'];
      } while ( scrollView.__content.contains(current = current.offsetParent) );

      (view.onRefreshLayout || angular.noop)();
      view.refreshDirection();

      // Create the pool of items for reuse, setting the size to (estimatedItemsOnScreen) * 2,
      // plus the size of the renderBuffer.
      if (!isLayoutReady) {
        var poolSize = 2 * view.scrollPrimarySize /
          view.estimatedPrimarySize * view.estimatedItemsAcross + (renderBuffer * 2);
        for (var i = 0; i < poolSize; i++) {
          itemsPool.push(new RepeatItem());
        }
      }

      isLayoutReady = true;
      if (isLayoutReady && isDataReady) {
        forceRerender();
      }
    };

    this.refreshData = function(newData) {
      newData || (newData = []);

      if (!angular.isArray(newData)) {
        throw new Error("collection-repeat expected an array for '" + listExpression + "', " +
          "but got a " + typeof value);
      }

      data = newData;
      (view.onRefreshData || angular.noop)();

      isDataReady = true;
      if (isLayoutReady && isDataReady) {
        forceRerender();
        setTimeout(angular.bind(scrollView, scrollView.resize));
      }
    };

    var unwatch = scope.$watchCollection(listExpression, angular.bind(this, this.refreshData));
    this.destroy = function() {
      render.destroyed = true;
      unwatch();

      scrollView.__calback = scrollView.__$callback;
      itemsPool.forEach(function(item) {
        item.scope.$destroy();
        item.scope = item.element = item.node = item.images = null;
      });
      itemsPool.length = itemsEntering.length = itemsLeaving.length = 0;
      itemsShownMap = {};

      (view.onDestroy || angular.noop)();
    };

    scrollView.options[isVertical ? 'getContentHeight' : 'getContentWidth'] =
      angular.bind(view, view.getContentSize);

    scrollView.__$callback = scrollView.__callback;
    scrollView.__callback = function(transformLeft, transformTop, zoom, wasResize) {
      var scrollValue = view.getScrollValue();
      if (renderStartIndex === -1 ||
          scrollValue + view.scrollPrimarySize > renderAfterBoundary ||
          scrollValue < renderBeforeBoundary) {
        render();
      }
      scrollView.__$callback(transformLeft, transformTop, zoom, wasResize);
    };


    function forceRerender() {
      return render(true);
    }
    function render(forceRerender) {
      if (render.destroyed) return;
      var i;
      var item;
      var dim;
      var scope;
      var scrollValue = view.getScrollValue();
      var scrollValueEnd = scrollValue + view.scrollPrimarySize;

      view.updateRenderRange(scrollValue, scrollValueEnd);

      renderStartIndex = Math.max(0, renderStartIndex - renderBuffer);
      renderEndIndex = Math.min(data.length - 1, renderEndIndex + renderBuffer);

      for (i in itemsShownMap) {
        if (i < renderStartIndex || i > renderEndIndex) {
          item = itemsShownMap[i];
          delete itemsShownMap[i];
          itemsLeaving.push(item);
          item.isShown = false;
          item.scope.$broadcast('$collectionRepeatChange');
        }
      }

      // Render indicies that aren't shown yet
      //
      // NOTE(ajoslin): this may sound crazy, but calling any other functions during this render
      // loop will often push the render time over the edge from less than one frame to over
      // one frame, causing visible jank.
      // DON'T call any other functions inside this loop unless it's vital.
      for (i = renderStartIndex; i <= renderEndIndex; i++) {
        // If the item at this index is already shown, skip
        if (i >= data.length || itemsShownMap[i] && !forceRerender) continue;

        item = itemsShownMap[i] || (itemsShownMap[i] = getNextItem());
        itemsEntering.push(item);
        item.isShown = true;

        scope = item.scope;
        scope.$index = i;
        scope[keyExpression] = data[i];
        scope.$first = (i === 0);
        scope.$last = (i === (data.length - 1));
        scope.$middle = !(scope.$first || scope.$last);
        scope.$odd = !(scope.$even = (i&1) === 0);

        if (scope.$$disconnected) ionic.Utils.reconnectScope(item.scope);

        dim = view.getDimensions(i);
        if (item.secondaryPos !== dim.secondaryPos || item.primaryPos !== dim.primaryPos) {
          item.node.style[ionic.CSS.TRANSFORM] = TRANSLATE_TEMPLATE_STR
            .replace(PRIMARY, (item.primaryPos = dim.primaryPos))
            .replace(SECONDARY, (item.secondaryPos = dim.secondaryPos));
        }
        if (item.secondarySize !== dim.secondarySize || item.primarySize !== dim.primarySize) {
          item.node.style.cssText = item.node.style.cssText
            .replace(WIDTH_HEIGHT_REGEX, WIDTH_HEIGHT_TEMPLATE_STR
              .replace(PRIMARY, 1 + (item.primarySize = dim.primarySize))
              .replace(SECONDARY, (item.secondarySize = dim.secondarySize))
            );
        }

      }

      // If we reach the end of the list, render the afterItemsNode - this contains all the
      // elements the developer placed after the collection-repeat
      if (renderEndIndex === data.length - 1) {
        dim = view.getDimensions(data.length - 1) || EMPTY_DIMENSION;
        afterItemsNode.style[ionic.CSS.TRANSFORM] = TRANSLATE_TEMPLATE_STR
          .replace(PRIMARY, dim.primaryPos + dim.primarySize)
          .replace(SECONDARY, 0);
      }

      while (itemsLeaving.length) {
        item = itemsLeaving.pop();
        ionic.Utils.disconnectScope(item.scope);
        itemsPool.push(item);
        item.node.style[ionic.CSS.TRANSFORM] = 'translate3d(-9999px,-9999px,0)';
        item.primaryPos = item.secondaryPos = null;
      }

      if (forceRefreshImages) {
        for (i = 0, ii = itemsEntering.length; i < ii && (item = itemsEntering[i]); i++) {
          if (!item.images) continue;
          for (var j = 0, jj = item.images.length, img; j < jj && (img = item.images[j]); j++) {
            var src = img.src;
            img.src = ONE_PX_TRANSPARENT_IMG_SRC;
            img.src = src;
          }
        }
      }
      if (forceRerender) {
        var rootScopePhase = $rootScope.$$phase;
        while (itemsEntering.length) {
          item = itemsEntering.pop();
          if (!rootScopePhase) item.scope.$digest();
        }
      } else {
        digestEnteringItems();
      }
    }

    function getNextItem() {
      if (itemsLeaving.length)
        return itemsLeaving.pop();
      else if (itemsPool.length)
        return itemsPool.shift();
      return new RepeatItem();
    }

    function digestEnteringItems() {
      var item;
      var scope;
      var len;
      if (digestEnteringItems.running) return;
      digestEnteringItems.running = true;

      $$rAF(function process() {
        if( (len = itemsEntering.length) ) {
          var count = Math.floor(len / 1.5) || 1;
          var rootScopePhase = $rootScope.$$phase;
          while (count && itemsEntering.length) {
            item = itemsEntering.pop();
            if (item.isShown) {
              count--;
              if (!$rootScope.$$phase) item.scope.$digest();
            }
          }
          $$rAF(process);
        } else {
          digestEnteringItems.running = false;
        }
      });
    }

    function RepeatItem() {
      var self = this;
      this.scope = scope.$new();
      this.id = 'item_'+ (nextItemId++);
      transclude(this.scope, function(clone) {
        self.element = clone;
        self.element.data('$$collectionRepeatItem', self);
        // TODO destroy
        self.node = clone[0];
        // Batch style setting to lower repaints
        self.node.style[ionic.CSS.TRANSFORM] = 'translate3d(-9999px,-9999px,0)';
        self.node.style.cssText += ' height: 0px; width: 0px;';
        ionic.Utils.disconnectScope(self.scope);
        containerNode.appendChild(self.node);
        self.images = clone[0].getElementsByTagName('img');
      });
    }

    function VerticalViewType() {
      this.getItemPrimarySize = heightGetter;
      this.getItemSecondarySize = widthGetter;

      this.getScrollValue = function() {
        return Math.max(0, Math.min(scrollView.__scrollTop - repeaterBeforeSize,
          scrollView.__maxScrollTop - repeaterBeforeSize - repeaterAfterSize));
      };

      this.refreshDirection = function() {
        this.scrollPrimarySize = scrollView.__clientHeight;
        this.scrollSecondarySize = scrollView.__clientWidth;

        this.estimatedPrimarySize = estimatedHeight;
        this.estimatedSecondarySize = estimatedWidth;
        this.estimatedItemsAcross = isGridView &&
          Math.floor(scrollView.__clientWidth / estimatedWidth) ||
          1;
      };
    }
    function HorizontalViewType() {
      this.getItemPrimarySize = widthGetter;
      this.getItemSecondarySize = heightGetter;

      this.getScrollValue = function() {
        return Math.max(0, Math.min(scrollView.__scrollLeft - repeaterBeforeSize,
          scrollView.__maxScrollLeft - repeaterBeforeSize - repeaterAfterSize));
      };

      this.refreshDirection = function() {
        this.scrollPrimarySize = scrollView.__clientWidth;
        this.scrollSecondarySize = scrollView.__clientHeight;

        this.estimatedPrimarySize = estimatedWidth;
        this.estimatedSecondarySize = estimatedHeight;
        this.estimatedItemsAcross = isGridView &&
          Math.floor(scrollView.__clientHeight / estimatedHeight) ||
          1;
      };
    }

    function GridViewType() {
      this.getEstimatedSecondaryPos = function(index) {
        return (index % this.estimatedItemsAcross) * this.estimatedPrimarySize;
      };
      this.getEstimatedPrimaryPos = function(index) {
        return Math.floor(index / this.estimatedItemsAcross) * this.estimatedPrimarySize;
      };
      this.getEstimatedIndex = function(scrollValue) {
        return Math.floor(scrollValue / this.estimatedPrimarySize) *
          this.estimatedItemsAcross;
      };
    }

    function ListViewType() {
      this.getEstimatedSecondaryPos = function() {
        return 0;
      };
      this.getEstimatedPrimaryPos = function(index) {
        return index * this.estimatedPrimarySize;
      };
      this.getEstimatedIndex = function(scrollValue) {
        return Math.floor((scrollValue) / this.estimatedPrimarySize);
      };
    }

    function StaticViewType() {
      this.getContentSize = function() {
        return this.getEstimatedPrimaryPos(data.length - 1) + this.estimatedPrimarySize +
          repeaterBeforeSize + repeaterAfterSize;
      };
      // static view always returns the same object for getDimensions, to avoid memory allocation
      // while scrolling. This could be dangerous if this was a public function, but it's not.
      // Only we use it.
      var dim = {};
      this.getDimensions = function(index) {
        dim.primaryPos = this.getEstimatedPrimaryPos(index);
        dim.secondaryPos = this.getEstimatedSecondaryPos(index);
        dim.primarySize = this.estimatedPrimarySize;
        dim.secondarySize = this.estimatedSecondarySize;
        return dim;
      };
      this.updateRenderRange = function(scrollValue, scrollValueEnd) {
        renderStartIndex = Math.max(0, this.getEstimatedIndex(scrollValue));

        // Make sure the renderEndIndex takes into account all the items on the row
        renderEndIndex = Math.min(data.length - 1,
          this.getEstimatedIndex(scrollValueEnd) + this.estimatedItemsAcross - 1);

        renderBeforeBoundary = Math.max(0,
          this.getEstimatedPrimaryPos(renderStartIndex));
        renderAfterBoundary = this.getEstimatedPrimaryPos(renderEndIndex) +
          this.estimatedPrimarySize;
      };
    }

    function DynamicViewType() {
      var self = this;
      var scrollViewSetDimensions = isVertical ?
        function() {
          scrollView.setDimensions(null, null, null, self.getContentSize(), true);
        } :
        function() {
          scrollView.setDimensions(null, null, self.getContentSize(), null, true);
        };
      var debouncedScrollViewSetDimensions = ionic.debounce(scrollViewSetDimensions, 25, true);
      var calculateDimensions = isGridView ? calculateDimensionsGrid : calculateDimensionsList;
      var dimensionsIndex;
      var dimensions = [];

      // Get the dimensions at index. {width, height, left, top}.
      // We start with no dimensions calculated, then any time dimensions are asked for at an
      // index we calculate dimensions up to there.
      function calculateDimensionsList(toIndex) {
        var i, prevDimension, dim;
        for (i = Math.max(0, dimensionsIndex); i <= toIndex && (dim = dimensions[i]); i++) {
          prevDimension = dimensions[i - 1] || EMPTY_DIMENSION;
          dim.primarySize = self.getItemPrimarySize(i, data[i]);
          dim.secondarySize = self.scrollSecondarySize;
          dim.primaryPos = prevDimension.primaryPos + prevDimension.primarySize;
          dim.secondaryPos = 0;
        }
      }
      function calculateDimensionsGrid(toIndex) {
        var i, prevDimension, dim;
        for (i = Math.max(dimensionsIndex, 0); i <= toIndex && (dim = dimensions[i]); i++) {
          prevDimension = dimensions[i - 1] || EMPTY_DIMENSION;
          dim.secondarySize = Math.min(
            self.getItemSecondarySize(i, data[i]),
            self.scrollSecondarySize
          );
          dim.secondaryPos = prevDimension.secondaryPos + prevDimension.secondarySize;

          if (i === 0 || dim.secondaryPos + dim.secondarySize > self.scrollSecondarySize) {
            dim.rowStartIndex = i;
            dim.secondaryPos = 0;
            dim.primarySize = self.getItemPrimarySize(i, data[i]);
            dim.primaryPos = prevDimension.primaryPos + prevDimension.primarySize;
          } else {
            dim.rowStartIndex = prevDimension.rowStartIndex;
            dim.primarySize = prevDimension.primarySize;
            dim.primaryPos = prevDimension.primaryPos;
          }
        }
      }

      this.getContentSize = function() {
        var dim = dimensions[dimensionsIndex] || EMPTY_DIMENSION;
        return ((dim.primaryPos + dim.primarySize) || 0) +
          this.getEstimatedPrimaryPos(data.length - dimensionsIndex - 1) +
          repeaterBeforeSize + repeaterAfterSize;
      };
      this.onDestroy = function() {
        dimensions.length = 0;
      };

      this.onRefreshData = function() {
        // Make sure dimensions has as many items as data.length.
        // This is to be sure we don't have to allocate objects while scrolling.
        for (i = dimensions.length, len = data.length; i < len; i++) {
          dimensions.push({});
        }
        dimensionsIndex = -1;
      };
      this.onRefreshLayout = function() {
        dimensionsIndex = -1;
      };
      this.getDimensions = function(index) {
        index = Math.min(index, data.length - 1);

        if (dimensionsIndex < index) {
          // Once we start asking for dimensions near the end of the list, go ahead and calculate
          // everything. This is to make sure when the user gets to the end of the list, the
          // scroll height of the list is 100% accurate (not estimated anymore).
          if (index > data.length * 0.9) {
            calculateDimensions(data.length - 1);
            dimensionsIndex = data.length - 1;
            scrollViewSetDimensions();
          } else {
            calculateDimensions(index);
            dimensionsIndex = index;
            debouncedScrollViewSetDimensions();
          }

        }
        return dimensions[index];
      };

      var oldRenderStartIndex = -1;
      var oldScrollValue = -1;
      this.updateRenderRange = function(scrollValue, scrollValueEnd) {
        var i;
        var len;
        var dim;

        // Calculate more dimensions than we estimate we'll need, to be sure.
        this.getDimensions( this.getEstimatedIndex(scrollValueEnd) * 2 );

        // -- Calculate renderStartIndex
        // base case: start at 0
        if (oldRenderStartIndex === -1 || scrollValue === 0) {
          i = 0;
        // scrolling down
        } else if (scrollValue >= oldScrollValue) {
          for (i = oldRenderStartIndex, len = data.length; i < len; i++) {
            if ((dim = this.getDimensions(i)) && dim.primaryPos + dim.primarySize >= scrollValue) {
              break;
            }
          }
        // scrolling up
        } else {
          for (i = oldRenderStartIndex; i >= 0; i--) {
            if ((dim = this.getDimensions(i)) && dim.primaryPos <= scrollValue) {
              // when grid view, make sure the render starts at the beginning of a row.
              i = isGridView ? dim.rowStartIndex : i;
              break;
            }
          }
        }

        renderStartIndex = Math.min(Math.max(0, i), data.length - 1);
        renderBeforeBoundary = renderStartIndex !== -1 ? this.getDimensions(renderStartIndex).primaryPos : -1;

        // -- Calculate renderEndIndex
        var lastRowDim;
        for (i = renderStartIndex + 1, len = data.length; i < len; i++) {
          if ((dim = this.getDimensions(i)) && dim.primaryPos + dim.primarySize > scrollValueEnd) {

            // Go all the way to the end of the row if we're in a grid
            if (isGridView) {
              lastRowDim = dim;
              while (i < len - 1 &&
                    (dim = this.getDimensions(i + 1)).primaryPos === lastRowDim.primaryPos) {
                i++;
              }
            }
            break;
          }
        }

        renderEndIndex = Math.min(i, data.length - 1);
        renderAfterBoundary = renderEndIndex !== -1 ?
          ((dim = this.getDimensions(renderEndIndex)).primaryPos + dim.primarySize) :
          -1;

        oldScrollValue = scrollValue;
        oldRenderStartIndex = renderStartIndex;
      };
    }


  };

}


