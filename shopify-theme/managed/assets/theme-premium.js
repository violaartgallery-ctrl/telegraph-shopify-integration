/* ==========================================
   VIOLA Premium Theme — JavaScript
   No jQuery. Vanilla JS only.
   Supports Shopify theme editor live preview.
   ========================================== */

(function() {
  'use strict';

  var PHOTO_PRINTING_FEE_VARIANT_ID = '54003265929508';

  function isPhotoPrintingFeeItem(item) {
    if (!item) return false;
    if (String(item.variant_id || item.id || '') === PHOTO_PRINTING_FEE_VARIANT_ID) return true;
    var props = item.properties || {};
    return props._viola_fee_type === 'photo_printing' || props._exclude_from_promos === 'true';
  }

  function getPromoCartStats(cart) {
    var subtotal = 0;
    var itemCount = 0;
    (cart.items || []).forEach(function(item) {
      if (isPhotoPrintingFeeItem(item)) return;
      subtotal += item.final_line_price !== undefined ? item.final_line_price : item.line_price;
      itemCount += item.quantity || 0;
    });
    return { subtotal: subtotal, itemCount: itemCount };
  }

  // ---- Sticky Header (runs once) ----
  var header = document.querySelector('.site-header');
  if (header) {
    window.addEventListener('scroll', function() {
      if (window.scrollY > 50) header.classList.add('scrolled');
      else header.classList.remove('scrolled');
    }, { passive: true });
  }

  // ---- Mobile Menu (runs once) ----
  document.addEventListener('click', function(e) {
    var toggle = e.target.closest('.menu-toggle');
    if (toggle) {
      var nav = document.querySelector('.mobile-nav');
      if (nav) { nav.classList.add('open'); document.body.style.overflow = 'hidden'; }
    }
    var close = e.target.closest('.mobile-nav-close');
    if (close) {
      var nav2 = document.querySelector('.mobile-nav');
      if (nav2) { nav2.classList.remove('open'); document.body.style.overflow = ''; }
    }
    if (e.target.classList && e.target.classList.contains('mobile-nav')) {
      e.target.classList.remove('open');
      document.body.style.overflow = '';
    }
  });

  // ==========================================================
  // initAll() — called on load AND on Shopify editor re-render
  // ==========================================================
  function initAll(scope) {
    var root = scope || document;

    // ---- Animations (IntersectionObserver) ----
    var animObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          animObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    root.querySelectorAll('.animate-on-scroll, .product-card, .insta-card, .insta-fade-in').forEach(function(el) {
      // Reset for editor re-render
      el.classList.remove('visible');
      animObserver.observe(el);
    });

    // ---- Stagger product cards ----
    function staggerCards(container) {
      var cards = container.querySelectorAll('.product-card');
      cards.forEach(function(card, i) {
        card.style.transitionDelay = (i * 60) + 'ms';
        card.classList.remove('visible');
        animObserver.observe(card);
      });
    }

    // ---- Tab Arrow Scrolling ----
    root.querySelectorAll('.tabs-arrow-left').forEach(function(btn) {
      btn.onclick = function() {
        var wrapper = this.closest('.tabs-outer').querySelector('.tabs-wrapper');
        if (wrapper) wrapper.scrollBy({ left: -150, behavior: 'smooth' });
      };
    });
    root.querySelectorAll('.tabs-arrow-right').forEach(function(btn) {
      btn.onclick = function() {
        var wrapper = this.closest('.tabs-outer').querySelector('.tabs-wrapper');
        if (wrapper) wrapper.scrollBy({ left: 150, behavior: 'smooth' });
      };
    });

    // ---- Tabs ----
    var tabBtns = root.querySelectorAll('.tab-btn');
    var tabContents = root.querySelectorAll('.tab-content');
    tabBtns.forEach(function(btn) {
      btn.onclick = function() {
        var target = this.getAttribute('data-tab');
        tabBtns.forEach(function(b) { b.classList.remove('active'); });
        tabContents.forEach(function(c) { c.classList.remove('active'); });
        this.classList.add('active');
        var targetEl = root.getElementById ? root.getElementById('tab-' + target) : document.getElementById('tab-' + target);
        if (!targetEl) targetEl = document.getElementById('tab-' + target);
        if (targetEl) {
          targetEl.classList.add('active');
          var cards = targetEl.querySelectorAll('.product-card');
          cards.forEach(function(card, i) {
            card.classList.remove('visible');
            card.style.transitionDelay = (i * 60) + 'ms';
            setTimeout(function() { card.classList.add('visible'); }, 50);
          });
        }
      };
    });

    // Init first tab stagger
    var firstTab = root.querySelector('.tab-content.active');
    if (firstTab) staggerCards(firstTab);

    // ---- Product Gallery Carousel ----
    var goToSlide = null; // exposed for variant swatches
    var carousel = root.querySelector('.pg-carousel');
    if (carousel) {
      var track = carousel.querySelector('.pg-track');
      var slides = carousel.querySelectorAll('.pg-slide');
      var dots = carousel.querySelectorAll('.pg-dot');
      var counter = carousel.querySelector('.pg-current');
      var thumbBtns = root.querySelectorAll('.product-thumbnails button');
      var currentIdx = 0;
      var totalSlides = slides.length;

      goToSlide = function(idx) {
        if (idx < 0) idx = totalSlides - 1;
        if (idx >= totalSlides) idx = 0;
        currentIdx = idx;
        slides[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        updateIndicators();
      }

      function updateIndicators() {
        dots.forEach(function(d, i) { d.classList.toggle('active', i === currentIdx); });
        if (counter) counter.textContent = currentIdx + 1;
        thumbBtns.forEach(function(t, i) { t.classList.toggle('active', i === currentIdx); });
        slides.forEach(function(s, i) { s.classList.toggle('active', i === currentIdx); });
      }

      // Arrows
      var prevBtn = carousel.querySelector('.pg-prev');
      var nextBtn = carousel.querySelector('.pg-next');
      if (prevBtn) prevBtn.onclick = function() { goToSlide(currentIdx - 1); };
      if (nextBtn) nextBtn.onclick = function() { goToSlide(currentIdx + 1); };

      // Dots
      dots.forEach(function(dot) {
        dot.onclick = function() { goToSlide(parseInt(this.getAttribute('data-index'))); };
      });

      // Thumbnails
      thumbBtns.forEach(function(btn) {
        btn.onclick = function() { goToSlide(parseInt(this.getAttribute('data-slide'))); };
      });

      // Detect scroll position to update active state
      var scrollTimer;
      track.addEventListener('scroll', function() {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(function() {
          var scrollLeft = track.scrollLeft;
          var slideWidth = track.offsetWidth;
          var newIdx = Math.round(scrollLeft / slideWidth);
          if (newIdx !== currentIdx && newIdx >= 0 && newIdx < totalSlides) {
            currentIdx = newIdx;
            updateIndicators();
          }
        }, 80);
      }, { passive: true });
    }

    // ---- Product Page: Variant Selection ----
    var variantsJson = root.querySelector ? root.querySelector('#product-variants-json') : document.getElementById('product-variants-json');
    if (!variantsJson) variantsJson = document.getElementById('product-variants-json');
    var variants = [];
    if (variantsJson) {
      try { variants = JSON.parse(variantsJson.textContent); } catch(e) {}
    }

    var selectedOptions = {};
    root.querySelectorAll('.variant-option-group').forEach(function(group) {
      var idx = group.getAttribute('data-option-index');
      var firstActive = group.querySelector('.color-img-swatch.active, .color-circle.active, .size-pill.active');
      if (firstActive) selectedOptions[idx] = firstActive.getAttribute('data-value');
    });

    // Color image swatches
    root.querySelectorAll('.color-img-swatch').forEach(function(swatch) {
      swatch.onclick = function() {
        var optIdx = this.getAttribute('data-option-index');
        this.closest('.color-img-swatches').querySelectorAll('.color-img-swatch').forEach(function(s) { s.classList.remove('active'); });
        this.classList.add('active');
        var nameEl = this.closest('.variant-option-group').querySelector('.selected-color-name');
        if (nameEl) nameEl.textContent = this.getAttribute('data-value');
        selectedOptions[optIdx] = this.getAttribute('data-value');
        updateProductVariant();

        // Scroll carousel to this variant's image
        var slideIdx = parseInt(this.getAttribute('data-slide-index'));
        if (slideIdx >= 0 && typeof goToSlide === 'function') {
          goToSlide(slideIdx);
        }
      };
    });

    root.querySelectorAll('.size-pill').forEach(function(pill) {
      pill.onclick = function() {
        var optIdx = this.getAttribute('data-option-index');
        this.closest('.size-pills').querySelectorAll('.size-pill').forEach(function(s) { s.classList.remove('active'); });
        this.classList.add('active');
        selectedOptions[optIdx] = this.getAttribute('data-value');
        updateProductVariant();
      };
    });

    function updateProductVariant() {
      if (variants.length === 0) return;
      var optionKeys = Object.keys(selectedOptions).sort();
      var selectedArr = optionKeys.map(function(k) { return selectedOptions[k]; });
      var matched = null;
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        var vOptions = [v.option1, v.option2, v.option3].filter(function(o) { return o !== null && o !== undefined; });
        if (vOptions.length === selectedArr.length) {
          var match = true;
          for (var j = 0; j < selectedArr.length; j++) {
            if (vOptions[j] !== selectedArr[j]) { match = false; break; }
          }
          if (match) { matched = v; break; }
        }
      }
      if (matched) {
        var hiddenInput = document.getElementById('selected-variant-id');
        if (hiddenInput) hiddenInput.value = matched.id;
        var priceEl = document.getElementById('product-price');
        if (priceEl) {
          var p = (parseInt(matched.price) / 100).toFixed(2);
          priceEl.textContent = 'LE ' + p + ' EGP';
        }
        var addBtn = document.getElementById('add-to-cart-btn');
        if (addBtn) {
          addBtn.setAttribute('data-variant-id', matched.id);
          if (matched.available) {
            addBtn.disabled = false;
            addBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Add to Cart';
          } else {
            addBtn.disabled = true;
            addBtn.textContent = 'Sold Out';
          }
        }
        var buyBtn = document.getElementById('buy-now-btn');
        if (buyBtn) buyBtn.style.display = matched.available ? 'flex' : 'none';
      }
    }
  }

  // ==========================================================
  // Card-level event handlers (delegated, run once)
  // ==========================================================

  // Card image swatch click
  document.addEventListener('click', function(e) {
    var swatch = e.target.closest('.card-img-swatch');
    if (!swatch) return;
    e.preventDefault(); e.stopPropagation();
    swatch.closest('.card-img-swatches').querySelectorAll('.card-img-swatch').forEach(function(s) { s.classList.remove('active'); });
    swatch.classList.add('active');
    var card = swatch.closest('.product-card');
    var label = swatch.closest('.card-option-group').querySelector('.card-selected-color');
    if (label) label.textContent = swatch.getAttribute('data-value');

    // Swap main card image to variant image
    var mainImg = swatch.getAttribute('data-main-img');
    var cardImg = card.querySelector('.card-main-img');
    if (mainImg && cardImg) {
      cardImg.src = mainImg;
    }

    var variant = cardFindVariant(card);
    if (variant) {
      // Also try to update image from variant JSON data
      if (!mainImg && variant.featured_image && variant.featured_image.src && cardImg) {
        cardImg.src = variant.featured_image.src.replace(/\?.*/, '') + '?width=600';
      }
      cardUpdateFromVariant(card, variant);
    }
  });

  // Card pill click
  document.addEventListener('click', function(e) {
    var pill = e.target.closest('.card-pill');
    if (!pill) return;
    e.preventDefault(); e.stopPropagation();
    pill.closest('.card-pills').querySelectorAll('.card-pill').forEach(function(p) { p.classList.remove('active'); });
    pill.classList.add('active');
    var card = pill.closest('.product-card');
    var variant = cardFindVariant(card);
    cardUpdateFromVariant(card, variant);
  });

  function cardFindVariant(card) {
    var jsonEl = card.querySelector('.card-variants-json');
    if (!jsonEl) return null;
    var variants;
    try { variants = JSON.parse(jsonEl.textContent); } catch(e) { return null; }
    var groups = card.querySelectorAll('.card-option-group');
    var selected = [];
    groups.forEach(function(g) {
      var active = g.querySelector('.card-img-swatch.active, .card-swatch.active, .card-pill.active');
      selected.push(active ? active.getAttribute('data-value') : null);
    });
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var opts = [v.option1, v.option2, v.option3];
      var match = true;
      for (var j = 0; j < selected.length; j++) {
        if (selected[j] && opts[j] !== selected[j]) { match = false; break; }
      }
      if (match) return v;
    }
    return null;
  }

  function cardUpdateFromVariant(card, variant) {
    if (!variant) return;
    var priceEl = card.querySelector('[data-card-price]');
    if (priceEl) {
      var p = (parseInt(variant.price) / 100).toFixed(2);
      priceEl.textContent = 'LE ' + p + ' EGP';
    }
    if (variant.featured_image) {
      var cardImg = card.querySelector('.card-main-img');
      if (cardImg && variant.featured_image.src) cardImg.src = variant.featured_image.src.replace(/\?.*/, '') + '?width=600';
    }
    var addBtn = card.querySelector('.card-add-to-cart');
    var buyBtn = card.querySelector('.card-buy-now');
    if (addBtn) {
      addBtn.setAttribute('data-variant-id', variant.id);
      if (!variant.available) {
        addBtn.disabled = true;
        addBtn.textContent = 'Sold Out';
        addBtn.classList.add('sold-out');
        if (buyBtn) buyBtn.style.display = 'none';
      } else {
        addBtn.disabled = false;
        addBtn.classList.remove('sold-out');
        addBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Add to Cart';
        if (buyBtn) { buyBtn.style.display = 'flex'; buyBtn.setAttribute('data-variant-id', variant.id); }
      }
    }
  }

  // Card Add to Cart
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.card-add-to-cart');
    if (!btn || btn.disabled) return;
    e.preventDefault(); e.stopPropagation();
    var variantId = btn.getAttribute('data-variant-id');
    if (!variantId) return;
    btn.disabled = true;
    var origHTML = btn.innerHTML;
    btn.textContent = '...';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: parseInt(variantId), quantity: 1 }] })
    })
    .then(parseCartResponse)
    .then(function() {
      btn.innerHTML = '&#10003; Added!';
      btn.style.background = '#16a34a';
      showCartNotification();
      updateCartCount();
      setTimeout(function() { btn.innerHTML = origHTML; btn.style.background = ''; btn.disabled = false; }, 1500);
    })
    .catch(function() { btn.innerHTML = origHTML; btn.disabled = false; });
  });

  // Card Buy Now
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.card-buy-now');
    if (!btn || btn.disabled) return;
    e.preventDefault(); e.stopPropagation();
    var variantId = btn.getAttribute('data-variant-id');
    if (!variantId) return;
    var origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '...';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: parseInt(variantId), quantity: 1 }] })
    })
    .then(parseCartResponse)
    .then(function() { window.location.href = '/cart'; })
    .catch(function(error) {
      btn.innerHTML = origHTML;
      btn.disabled = false;
      window.alert('تعذر إضافة المنتج إلى السلة. من فضلك حاول مرة أخرى.');
      console.error(error);
    });
  });

  // Product customization controls
  document.addEventListener('click', function(e) {
    var writingModeBtn = e.target.closest('[data-custom-writing-mode]');
    if (writingModeBtn) {
      e.preventDefault();
      var modeField = writingModeBtn.closest('[data-custom-field]');
      var selectedMode = writingModeBtn.getAttribute('data-custom-writing-mode');
      if (!modeField || !selectedMode) return;

      if (selectedMode === 'logo') {
        var accepted = window.confirm('تنبيه مهم: لازم صورة اللوجو تكون بخلفية بيضاء واللوجو/الشكل باللون الأسود. اضغط OK لو الصورة جاهزة بالشكل ده.');
        if (!accepted) return;
      }

      modeField.querySelectorAll('[data-custom-writing-mode]').forEach(function(btn) {
        var active = btn === writingModeBtn;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      modeField.querySelectorAll('[data-custom-writing-panel]').forEach(function(panel) {
        panel.classList.toggle('active', panel.getAttribute('data-custom-writing-panel') === selectedMode);
      });
      var modeWarning = modeField.querySelector('[data-custom-field-warning]');
      if (modeWarning) modeWarning.textContent = '';
      return;
    }

    var toggle = e.target.closest('[data-custom-field-toggle]');
    if (!toggle) return;
    e.preventDefault();
    var field = toggle.closest('[data-custom-field]');
    if (!field) return;
    var isOpen = field.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    var warning = field.querySelector('[data-custom-field-warning]');
    if (warning) warning.textContent = '';
    if (isOpen) {
      var textInput = field.querySelector('[data-custom-text-input]');
      var fileInput = field.querySelector('[data-custom-file-input]');
      setTimeout(function() {
        if (textInput) textInput.focus();
        if (fileInput) fileInput.focus();
      }, 80);
    }
  });

  document.addEventListener('change', function(e) {
    var logoInput = e.target.closest('[data-custom-logo-input]');
    if (logoInput) {
      var logoField = logoInput.closest('[data-custom-field]');
      var logoName = logoField ? logoField.querySelector('[data-custom-logo-name]') : null;
      if (logoName) logoName.textContent = logoInput.files && logoInput.files[0] ? logoInput.files[0].name : 'صورة واحدة فقط';
      var logoWarning = logoField ? logoField.querySelector('[data-custom-field-warning]') : null;
      if (logoWarning) logoWarning.textContent = '';
      return;
    }

    var input = e.target.closest('[data-custom-file-input]');
    if (!input) return;
    var field = input.closest('[data-custom-field]');
    var fileName = field ? field.querySelector('[data-custom-file-name]') : null;
    var maxFiles = parseInt(input.getAttribute('data-custom-file-max'), 10);
    if (maxFiles && input.files && input.files.length > maxFiles) {
      window.alert('مسموح برفع ' + maxFiles + ' صور فقط لهذا المنتج.');
      input.value = '';
      if (fileName) fileName.textContent = maxFiles + ' صور كحد أقصى';
      return;
    }
    if (fileName) {
      if (input.files && input.files.length > 1) {
        fileName.textContent = input.files.length + ' صور مختارة';
      } else {
        fileName.textContent = input.files && input.files[0] ? input.files[0].name : 'PNG أو JPG';
      }
    }
    var warning = field ? field.querySelector('[data-custom-field-warning]') : null;
    if (warning) warning.textContent = '';
  });

  function getProductQuantity() {
    var qtyInput = document.getElementById('product-quantity');
    var quantity = qtyInput ? parseInt(qtyInput.value, 10) : 1;
    if (!quantity || quantity < 1) quantity = 1;
    return quantity;
  }

  function collectProductCustomization() {
    var properties = {};
    var files = [];
    var customizationRoot = document.querySelector('[data-customization-root]');
    if (!customizationRoot) return { properties: properties, files: files, feeVariantId: '', feeQuantity: 0 };

    var feeVariantId = customizationRoot.getAttribute('data-photo-fee-variant-id') || '';
    var feeAmount = customizationRoot.getAttribute('data-photo-fee-amount') || '30';
    var chargePhotoFee = feeVariantId && parseInt(feeAmount, 10) > 0;
    var feeQuantity = 0;

    customizationRoot.querySelectorAll('[data-custom-field].is-open').forEach(function(field) {
      var label = field.getAttribute('data-field-label');
      var warning = field.querySelector('[data-custom-field-warning]');
      var textInput = field.querySelector('[data-custom-text-input]');
      var logoInput = field.querySelector('[data-custom-logo-input]');
      var fileInput = field.querySelector('[data-custom-file-input]');
      var hasValue = false;

      if (!label) return;

      if (logoInput && field.querySelector('[data-custom-writing-mode="logo"].active')) {
        if (logoInput.files && logoInput.files[0]) {
          files.push({ label: label + ' لوجو', file: logoInput.files[0] });
          hasValue = true;
        }
      } else if (textInput) {
        var value = textInput.value.trim();
        if (value) {
          properties[label] = value;
          hasValue = true;
        }
      }

      if (fileInput && fileInput.files && fileInput.files.length) {
        Array.prototype.forEach.call(fileInput.files, function(file, index) {
          var fileLabel = fileInput.files.length > 1 ? label + ' ' + (index + 1) : label;
          files.push({ label: fileLabel, file: file });
        });
        properties['عدد صور ' + label] = String(fileInput.files.length);
        if (chargePhotoFee) {
          properties['تكلفة ' + label] = (parseInt(feeAmount, 10) * fileInput.files.length) + ' ج';
          feeQuantity += fileInput.files.length;
        } else {
          properties['تكلفة ' + label] = 'مجانا';
        }
        hasValue = true;
      }

      if (warning) {
        warning.textContent = hasValue ? '' : 'الخانة مفتوحة وفاضية، ممكن تكمل الطلب أو تضيف التفاصيل.';
      }
    });

    return { properties: properties, files: files, feeVariantId: feeVariantId, feeQuantity: feeQuantity };
  }

  function buildProductAddRequest(variantId) {
    var quantity = getProductQuantity();
    var customization = collectProductCustomization();
    var propertyKeys = Object.keys(customization.properties);

    if (customization.files.length) {
      var formData = new window.FormData();
      formData.append('id', variantId);
      formData.append('quantity', quantity);
      propertyKeys.forEach(function(key) {
        formData.append('properties[' + key + ']', customization.properties[key]);
      });
      customization.files.forEach(function(item) {
        formData.append('properties[' + item.label + ']', item.file);
      });
      return { body: formData, feeVariantId: customization.feeVariantId, feeQuantity: customization.feeQuantity };
    }

    var lineItem = { id: parseInt(variantId), quantity: quantity };
    if (propertyKeys.length) lineItem.properties = customization.properties;
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [lineItem] }),
      feeVariantId: customization.feeVariantId,
      feeQuantity: customization.feeQuantity
    };
  }

  function parseCartResponse(response) {
    return response.json().then(function(data) {
      if (!response.ok) {
        var message = data && (data.description || data.message || data.status);
        throw new Error(message || 'Cart request failed');
      }
      return data;
    });
  }

  function getAddedCartKey(data) {
    if (!data) return '';
    if (data.key) return data.key;
    if (data.items && data.items[0] && data.items[0].key) return data.items[0].key;
    return '';
  }

  function removeCartLineByKey(key) {
    if (!key) return Promise.resolve();
    return fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: key, quantity: 0 })
    }).then(parseCartResponse).catch(function() {});
  }

  function addPhotoFeeIfNeeded(addRequest, attempt) {
    if (!addRequest || !addRequest.feeVariantId || !addRequest.feeQuantity) {
      return Promise.resolve();
    }
    return fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          id: parseInt(addRequest.feeVariantId, 10),
          quantity: addRequest.feeQuantity,
          properties: {
            '_viola_fee_type': 'photo_printing',
            '_exclude_from_promos': 'true',
            '_exclude_from_free_shipping': 'true',
            '_رسوم': 'طباعة صورة'
          }
        }]
      })
    }).then(parseCartResponse).catch(function(error) {
      if (!attempt) {
        return new Promise(function(resolve) {
          setTimeout(resolve, 450);
        }).then(function() {
          return addPhotoFeeIfNeeded(addRequest, 1);
        });
      }
      throw error;
    });
  }

  // Product page Add to Cart
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.add-to-cart-main');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    var variantId = btn.getAttribute('data-variant-id');
    if (!variantId) {
      var input = document.getElementById('selected-variant-id');
      if (input) variantId = input.value;
    }
    if (!variantId) return;
    btn.disabled = true;
    var origHTML = btn.innerHTML;
    btn.textContent = '...';
    var addRequest = buildProductAddRequest(variantId);
    var addedCartKey = '';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: addRequest.headers,
      body: addRequest.body
    })
    .then(parseCartResponse)
    .then(function(data) {
      addedCartKey = getAddedCartKey(data);
      return addPhotoFeeIfNeeded(addRequest);
    })
    .then(function() {
      btn.innerHTML = '&#10003; Added!';
      showCartNotification();
      updateCartCount();
      setTimeout(function() { btn.innerHTML = origHTML; btn.disabled = false; }, 1500);
    })
    .catch(function(error) {
      removeCartLineByKey(addedCartKey).then(function() {
        window.alert('لم يتم إضافة تكلفة طباعة الصور. من فضلك جرّب إضافة المنتج مرة أخرى.');
        console.error(error);
        btn.innerHTML = origHTML;
        btn.disabled = false;
        updateCartCount();
      });
    });
  });

  // Product page Buy Now
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('#buy-now-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    var input = document.getElementById('selected-variant-id');
    if (!input || !input.value) {
      window.alert('من فضلك اختر المنتج المطلوب ثم حاول مرة أخرى.');
      return;
    }
    var origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'جاري الإضافة...';
    var addRequest = buildProductAddRequest(input.value);
    var addedCartKey = '';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: addRequest.headers,
      body: addRequest.body
    })
    .then(parseCartResponse)
    .then(function(data) {
      addedCartKey = getAddedCartKey(data);
      return addPhotoFeeIfNeeded(addRequest);
    })
    .then(function() { window.location.href = '/cart'; })
    .catch(function(error) {
      removeCartLineByKey(addedCartKey).then(function() {
        btn.innerHTML = origHTML;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        window.alert('تعذر إضافة المنتج إلى السلة. من فضلك حاول مرة أخرى.');
        console.error(error);
      });
    });
  });

  function showCartNotification() {
    // Instead of a toast, open the cart drawer
    refreshCartDrawer();
    var drawer = document.getElementById('cart-drawer');
    var overlays = document.querySelectorAll('.drawer-overlay[data-close="cart-drawer"]');
    if (drawer) {
      setTimeout(function() {
        drawer.classList.add('open');
        overlays.forEach(function(o) { o.classList.add('open'); });
        document.body.style.overflow = 'hidden';
      }, 300);
    }
  }

  function updateCartCount() {
    fetch('/cart.js')
      .then(function(r) { return r.json(); })
      .then(function(cart) {
        var promoStats = getPromoCartStats(cart);
        document.querySelectorAll('.cart-count').forEach(function(el) { el.textContent = promoStats.itemCount; });
        // Update drawer title
        document.querySelectorAll('.drawer-title').forEach(function(el) {
          if (el.textContent.includes('Cart')) el.textContent = 'Cart (' + promoStats.itemCount + ')';
        });
      });
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderCartProperties(properties) {
    if (!properties) return '';
    var keys = Object.keys(properties).filter(function(key) {
      return key && key.charAt(0) !== '_' && properties[key] !== null && properties[key] !== '';
    });
    if (!keys.length) return '';

    var html = '<div class="cart-line-properties">';
    keys.forEach(function(key) {
      var value = properties[key];
      var safeKey = escapeHTML(key);
      var safeValue = escapeHTML(value);
      var isLink = typeof value === 'string' && (value.indexOf('http') === 0 || value.indexOf('/') === 0);
      html += '<div class="cart-line-property"><strong>' + safeKey + ':</strong> ';
      html += isLink ? '<a href="' + safeValue + '" target="_blank" rel="noopener">عرض الملف</a>' : '<span>' + safeValue + '</span>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function refreshCartDrawer() {
    return fetch('/cart.js')
      .then(parseCartResponse)
      .then(function(cart) {
        var promoStats = getPromoCartStats(cart);
        // Update count
        document.querySelectorAll('.cart-count').forEach(function(el) { el.textContent = promoStats.itemCount; });
        document.querySelectorAll('.drawer-title').forEach(function(el) {
          if (el.textContent.includes('Cart')) el.textContent = 'Cart (' + promoStats.itemCount + ')';
        });

        // Rebuild drawer body
        var body = document.getElementById('cart-drawer-body');
        if (!body) return;

        if (cart.items.length === 0) {
          body.innerHTML = '<div class="cart-drawer-empty"><p>Your cart is empty</p></div>';
          // Hide footer
          var footer = body.parentElement.querySelector('.drawer-footer');
          if (footer) footer.style.display = 'none';
          return;
        }

        var html = '';
        cart.items.forEach(function(item, index) {
          var imgSrc = item.image ? item.image.replace(/(\.[^.]+)$/, '_120x$1') : '';
          var variantTitle = item.variant_title && item.variant_title !== 'Default Title' ? '<div class="cart-drawer-variant">' + item.variant_title + '</div>' : '';
          var price = 'LE ' + (item.line_price / 100).toFixed(2) + ' EGP';
          var lineKey = item.key;
          html += '<div class="cart-drawer-item" data-line-key="' + lineKey + '">';
          html += '<div class="cart-drawer-img">';
          if (imgSrc) html += '<img src="' + imgSrc + '" alt="' + item.title + '">';
          html += '</div>';
          html += '<div class="cart-drawer-info">';
          html += '<a href="' + item.url + '" class="cart-drawer-name">' + item.product_title + '</a>';
          html += variantTitle;
          html += renderCartProperties(item.properties);
          html += '<div class="cart-drawer-controls">';
          html += '<div class="cart-qty-wrap">';
          html += '<button type="button" class="cart-qty-btn cart-qty-minus" data-key="' + lineKey + '" data-qty="' + (item.quantity - 1) + '" aria-label="Decrease">−</button>';
          html += '<span class="cart-qty-num">' + item.quantity + '</span>';
          html += '<button type="button" class="cart-qty-btn cart-qty-plus" data-key="' + lineKey + '" data-qty="' + (item.quantity + 1) + '" aria-label="Increase">+</button>';
          html += '</div>';
          html += '<button type="button" class="cart-remove-btn" data-key="' + lineKey + '" aria-label="Remove">';
          html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
          html += '</button>';
          html += '</div>';
          html += '<div class="cart-drawer-price">' + price + '</div>';
          html += '</div></div>';
        });
        body.innerHTML = html;

        // Update footer
        var footer = body.parentElement.querySelector('.drawer-footer');
        if (footer) {
          footer.style.display = '';
          var totalEl = footer.querySelector('.cart-drawer-total');
          if (totalEl) {
            var totalPrice = 'LE ' + (cart.total_price / 100).toFixed(2) + ' EGP';
            totalEl.innerHTML = '<span>Total</span><span>' + totalPrice + '</span>';
          }
        } else {
          // Create footer if doesn't exist
          var drawerEl = body.parentElement;
          var newFooter = document.createElement('div');
          newFooter.className = 'drawer-footer';
          var totalPrice = 'LE ' + (cart.total_price / 100).toFixed(2) + ' EGP';
          newFooter.innerHTML = '<div class="cart-drawer-total"><span>Total</span><span>' + totalPrice + '</span></div><a href="/checkout" class="cart-drawer-checkout">Checkout</a><a href="/cart" class="cart-drawer-viewcart">View Cart</a>';
          drawerEl.appendChild(newFooter);
        }
      });
  }

  // Cart quantity change (+/-) — optimistic instant UI
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.cart-qty-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    var key = btn.getAttribute('data-key');
    var qty = parseInt(btn.getAttribute('data-qty'));
    if (qty < 0) qty = 0;

    // Instant UI update
    var item = btn.closest('.cart-drawer-item');
    var lineActionButtons = item ? item.querySelectorAll('.cart-qty-btn, .cart-remove-btn') : [];
    lineActionButtons.forEach(function(control) { control.disabled = true; });
    var numEl = item.querySelector('.cart-qty-num');
    var minusBtn = item.querySelector('.cart-qty-minus');
    var plusBtn = item.querySelector('.cart-qty-plus');

    if (qty === 0) {
      // Remove item instantly
      item.style.transition = 'opacity 0.2s, transform 0.2s';
      item.style.opacity = '0';
      item.style.transform = 'translateX(30px)';
      item.style.pointerEvents = 'none';
    } else {
      numEl.textContent = qty;
      minusBtn.setAttribute('data-qty', qty - 1);
      plusBtn.setAttribute('data-qty', qty + 1);
    }

    // Sync with server
    fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: key, quantity: qty })
    })
    .then(parseCartResponse)
    .then(function(cart) {
      // Update count + total from server
      var promoStats = getPromoCartStats(cart);
      document.querySelectorAll('.cart-count').forEach(function(el) { el.textContent = promoStats.itemCount; });
      document.querySelectorAll('.drawer-title').forEach(function(el) {
        if (el.textContent.includes('Cart')) el.textContent = 'Cart (' + promoStats.itemCount + ')';
      });
      var footer = document.querySelector('#cart-drawer .drawer-footer');
      if (footer) {
        var totalEl = footer.querySelector('.cart-drawer-total');
        if (totalEl) totalEl.innerHTML = '<span>Total</span><span>LE ' + (cart.total_price / 100).toFixed(2) + ' EGP</span>';
        footer.style.display = cart.items.length > 0 ? '' : 'none';
      }
      // Update price for this item
      if (qty > 0 && item) {
        var serverItem = cart.items.find(function(i) { return i.key === key; });
        if (serverItem) {
          var priceEl = item.querySelector('.cart-drawer-price');
          if (priceEl) priceEl.textContent = 'LE ' + (serverItem.line_price / 100).toFixed(2) + ' EGP';
        }
        lineActionButtons.forEach(function(control) { control.disabled = false; });
      }
      // If removed, clean up after animation
      if (qty === 0) {
        setTimeout(function() {
          if (item && item.parentNode) item.parentNode.removeChild(item);
          if (cart.items.length === 0) {
            var body = document.getElementById('cart-drawer-body');
            if (body) body.innerHTML = '<div class="cart-drawer-empty"><p>Your cart is empty</p></div>';
          }
        }, 250);
      }
    })
    .catch(function() {
      lineActionButtons.forEach(function(control) { control.disabled = false; });
      refreshCartDrawer();
    });
  });

  // Cart remove item — instant
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.cart-remove-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    btn.disabled = true;
    var key = btn.getAttribute('data-key');
    var item = btn.closest('.cart-drawer-item');
    if (item) {
      item.style.transition = 'opacity 0.2s, transform 0.2s';
      item.style.opacity = '0';
      item.style.transform = 'translateX(30px)';
      item.style.pointerEvents = 'none';
    }
    fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: key, quantity: 0 })
    })
    .then(parseCartResponse)
    .then(function(cart) {
      var promoStats = getPromoCartStats(cart);
      document.querySelectorAll('.cart-count').forEach(function(el) { el.textContent = promoStats.itemCount; });
      document.querySelectorAll('.drawer-title').forEach(function(el) {
        if (el.textContent.includes('Cart')) el.textContent = 'Cart (' + promoStats.itemCount + ')';
      });
      setTimeout(function() {
        if (item && item.parentNode) item.parentNode.removeChild(item);
        if (cart.items.length === 0) {
          var body = document.getElementById('cart-drawer-body');
          if (body) body.innerHTML = '<div class="cart-drawer-empty"><p>Your cart is empty</p></div>';
          var footer = document.querySelector('#cart-drawer .drawer-footer');
          if (footer) footer.style.display = 'none';
        } else {
          var footer = document.querySelector('#cart-drawer .drawer-footer');
          if (footer) {
            var totalEl = footer.querySelector('.cart-drawer-total');
            if (totalEl) totalEl.innerHTML = '<span>Total</span><span>LE ' + (cart.total_price / 100).toFixed(2) + ' EGP</span>';
          }
        }
      }, 250);
    })
    .catch(function() { refreshCartDrawer(); });
  });

  // ==========================================================
  // Run on page load
  // ==========================================================
  initAll(document);
  syncMetaClickAttributes();

  // ==========================================================
  // Shopify Theme Editor — re-init on section render
  // ==========================================================
  if (window.Shopify && window.Shopify.designMode) {
    document.addEventListener('shopify:section:load', function(e) {
      initAll(e.target);
    });
    document.addEventListener('shopify:section:reorder', function(e) {
      initAll(document);
    });
    document.addEventListener('shopify:block:select', function(e) {
      // Scroll to the selected block in tabs
      var tab = e.target.closest('.tab-content');
      if (tab && !tab.classList.contains('active')) {
        var tabId = tab.id.replace('tab-', '');
        var btn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
        if (btn) btn.click();
      }
      // Scroll Instagram block into view
      if (e.target.closest('.insta-slide')) {
        e.target.closest('.insta-slide').scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });
  }

  function syncMetaClickAttributes() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fbclid = params.get('fbclid');
      var now = Date.now();
      var fbc = getCookie('_fbc');
      var fbp = getCookie('_fbp');
      var fbLoginId = '';

      if (fbclid) {
        fbc = 'fb.1.' + now + '.' + fbclid;
        setCookie('_fbc', fbc, 90);
      }

      if (!fbp) {
        fbp = 'fb.1.' + now + '.' + Math.floor(Math.random() * 10000000000);
        setCookie('_fbp', fbp, 90);
      }

      if (window.FB && typeof window.FB.getLoginStatus === 'function') {
        window.FB.getLoginStatus(function(response) {
          if (response && response.status === 'connected' && response.authResponse && response.authResponse.userID) {
            fbLoginId = response.authResponse.userID;
          }
          persistMetaAttributes(fbc, fbp, fbclid, fbLoginId);
        });
        return;
      }

      persistMetaAttributes(fbc, fbp, fbclid, fbLoginId);
    } catch (e) {}
  }

  function persistMetaAttributes(fbc, fbp, fbclid, fbLoginId) {
    var attributes = {};
    if (fbc) attributes._fbc = fbc;
    if (fbp) attributes._fbp = fbp;
    if (fbclid) attributes._fbclid = fbclid;
    attributes._event_source_url = window.location.href;
    if (fbLoginId) attributes._fb_login_id = fbLoginId;
    if (!Object.keys(attributes).length) return;

    var signature = JSON.stringify(attributes);
    if (window.localStorage && localStorage.getItem('viola_meta_attrs') === signature) return;

    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: attributes })
    }).then(function() {
      if (window.localStorage) localStorage.setItem('viola_meta_attrs', signature);
    }).catch(function() {});
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Lax';
  }

})();
