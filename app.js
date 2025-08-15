
// Dream Builder Runtime - Self-contained scene renderer
(async function() {
  const canvas = document.getElementById('renderCanvas');
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  // Make scene graph available to helper functions outside the try block scope
  let EXPORTED_SCENE_GRAPH = null;

  // Show loading
  function showLoading(message) {
    const overlay = document.getElementById('loadingOverlay');
    const text = document.getElementById('loadingText');
    if (overlay && text) {
      overlay.classList.remove('hidden');
      text.textContent = message;
    }
  }

  // Hide loading
  function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  }

  // Show error
  function showError(message) {
    const overlay = document.getElementById('loadingOverlay');
    const text = document.getElementById('loadingText');
    if (overlay && text) {
      overlay.classList.remove('hidden');
      text.innerHTML = '<div class="error"><strong>Error:</strong><br>' + message + '</div>';
    }
  }

  // Texture helpers for overrides
  function isTextureProperty(prop) {
    const textureProps = [
      'albedoTexture', 'baseTexture', 'diffuseTexture',
      'metallicTexture', 'roughnessTexture', 'metallicRoughnessTexture',
      'reflectionTexture', 'refractionTexture',
      'normalTexture', 'bumpTexture',
      'emissiveTexture',
      'opacityTexture',
      'ambientTexture',
      'lightmapTexture',
      'clearCoatTexture', 'clearCoatNormalTexture', 'clearCoatRoughnessTexture',
      'sheenTexture', 'sheenRoughnessTexture'
    ];
    return textureProps.includes(prop);
  }

  // Extract a clean filename from a URL or path, removing query/hash and UUID prefixes
  function getFilenameFromUrl(url) {
    if (!url) return '';
    try {
      const lastPart = String(url).split('/').pop() || '';
      const clean = lastPart.split('?')[0].split('#')[0];
      // Remove UUID prefix in the form: 36-char uuid followed by underscore
      const uuidPattern = /^[a-f0-9-]{36}_(.+)$/i;
      const m = clean.match(uuidPattern);
      return m ? m[1] : clean;
    } catch {
      return '';
    }
  }

  function loadTextureFromAssetPath(assetStoragePath, scene) {
    if (!assetStoragePath || !scene) return null;
    try {
      console.log('🔍 RUNTIME: Loading texture from storage path:', assetStoragePath);
      
      // Use the toRelativeAssetPath function to convert storage path to relative path
      const rel = toRelativeAssetPath(assetStoragePath);
      const url = 'assets/' + rel;
      
      console.log('🔍 RUNTIME: Converted storage path to URL:', assetStoragePath, '->', url);
      
      const texture = new BABYLON.Texture(url, scene);
      const parts2 = url.split('/');
      texture.name = parts2[parts2.length - 1];
      return texture;
    } catch (e) {
      console.warn('❌ RUNTIME: Failed to load texture for override:', assetStoragePath, e);
      return null;
    }
  }

  try {
    showLoading('Initializing viewer...');
    
    // Create Babylon.js engine
    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    engine.enableOfflineSupport = false;

    // Create scene
    const scene = new BABYLON.Scene(engine);
    // Match editor/viewer coordinate system so rotations are consistent
    scene.useRightHandedSystem = true;
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0); // Transparent background

    // Rely on Scene.useRightHandedSystem; Babylon's GLTF loader auto-aligns to scene

    showLoading('Loading scene...');
    
    // Load scene graph
    const response = await fetch('scene.json', { 
      cache: 'no-store', 
      headers: { 'Cache-Control': 'no-cache' } 
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch scene: ' + response.status + ' ' + response.statusText);
    }
    
    const sceneGraph = await response.json();
    console.log('Scene graph loaded:', sceneGraph);
    EXPORTED_SCENE_GRAPH = sceneGraph;

    // Validate scene graph
    if (!sceneGraph || !sceneGraph.nodes || !Array.isArray(sceneGraph.nodes)) {
      throw new Error('Invalid scene graph format');
    }

    showLoading('Creating scene objects...');
    
    // Instantiate scene from graph
    await instantiateGraph(sceneGraph, scene);

    // Apply scene settings if they exist
    if (sceneGraph.sceneSettings) {
      showLoading('Applying scene settings...');
      await applySceneSettings(scene, sceneGraph.sceneSettings);
    }

    showLoading('Preparing scene...');
    
    // Wait for scene to be ready
    await scene.whenReadyAsync();

    // Apply material overrides after scene is fully ready
    if (sceneGraph.materialOverrides) {
      showLoading('Applying material overrides...');
      // Add a longer delay to ensure all materials and textures including IBL are fully initialized
      await new Promise(resolve => setTimeout(resolve, 250));
      applyMaterialOverrides(scene, sceneGraph.materialOverrides);
    }

    // CRITICAL FIX: Final IBL material refresh after everything is loaded
    // This is what happens when you enable skybox in editor - it fixes the reflections!
    if (scene.environmentTexture) {
      console.log('🔧 Final IBL material refresh (replicates skybox creation fix)');
      setTimeout(() => {
        refreshMaterialsForIBL(scene);
        console.log('🎉 Runtime IBL reflections should now be correct!');
      }, 300);
    }

    // Start render loop
    engine.runRenderLoop(() => {
      if (scene) {
        scene.render();
      }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      if (engine) {
        engine.resize();
      }
    });

    // Hide loading overlay
    hideLoading();
    
  } catch (error) {
    showError('Failed to load scene: ' + error.message);
    console.error('Runtime error:', error);
  }

  // Instantiate scene graph (adapted from viewer.js)
  async function instantiateGraph(graph, scene) {
    console.log('🏗️ Instantiating scene graph with', graph.nodes.length, 'nodes');
    
    // First pass: Create all non-child-mesh objects (models, lights, cameras, top-level meshes)
    const childMeshNodes = [];
    for (const node of graph.nodes) {
      if (node.kind === 'mesh' && node.id.includes('::mesh::') && node.parentId) {
        // Defer child mesh processing
        childMeshNodes.push(node);
      } else {
        await instantiateNode(node, scene);
      }
    }

    // Second pass: Apply transforms to child meshes (after models are loaded)
    if (childMeshNodes.length > 0) {
      console.log('🎯 Processing', childMeshNodes.length, 'child mesh transforms...');
      for (const node of childMeshNodes) {
        await instantiateNode(node, scene);
      }
    }
    
    console.log('✅ Graph instantiation complete');
  }

  async function instantiateNode(node, scene) {
    const position = new BABYLON.Vector3(...node.transform.position);
    const rotation = node.transform.rotation ? new BABYLON.Vector3(...node.transform.rotation) : BABYLON.Vector3.Zero();
    const scaling = node.transform.scaling ? new BABYLON.Vector3(...node.transform.scaling) : BABYLON.Vector3.One();

    try {
      switch (node.kind) {
        case 'camera':
          // Create camera based on type stored in scene graph
          let camera;
          const cameraProps = node.camera || { type: 'ArcRotate', minZ: 0.1, maxZ: 100 };
          
          if (cameraProps.type === 'Universal') {
            camera = new BABYLON.UniversalCamera(node.id, position, scene);
            if (rotation) {
              camera.rotation = rotation;
            }
          } else {
            // ArcRotate (default)
            const alpha = cameraProps.alpha || -Math.PI / 2;
            const beta = cameraProps.beta || Math.PI / 2.5;
            const radius = cameraProps.radius || position.length() || 15;
            const target = cameraProps.target ? new BABYLON.Vector3(...cameraProps.target) : BABYLON.Vector3.Zero();
            
            camera = new BABYLON.ArcRotateCamera(node.id, alpha, beta, radius, target, scene);
            
            // Set radius limits if specified
            if (cameraProps.lowerRadiusLimit !== undefined) {
              camera.lowerRadiusLimit = cameraProps.lowerRadiusLimit;
            }
            if (cameraProps.upperRadiusLimit !== undefined) {
              camera.upperRadiusLimit = cameraProps.upperRadiusLimit;
            }
          }
          
          // Set common camera properties (use exact values from editor)
          camera.minZ = typeof cameraProps.minZ === 'number' ? cameraProps.minZ : 0.1;
          camera.maxZ = typeof cameraProps.maxZ === 'number' ? cameraProps.maxZ : 100;
          
          // Apply enabled state
          const cameraEnabled = node.enabled !== false;
          camera.setEnabled(cameraEnabled);
          
          // Set as active camera if marked as such (and attach controls)
          if (cameraProps.active) {
            scene.activeCamera = camera;
            camera.attachControl(canvas, true);
          }
          
          break;

        case 'light': {
          // Create light based on saved type and properties
          let light;
          const lightProps = node.light || { type: 'Hemispheric', intensity: 0.7, color: [1, 1, 1], enabled: true };

          switch (lightProps.type) {
            case 'Point': {
              light = new BABYLON.PointLight(node.id, position, scene);
              if (lightProps.range !== undefined) {
                light.range = lightProps.range;
              }
              break;
            }
            case 'Spot': {
              // Compute direction from node rotation
              let direction = new BABYLON.Vector3(0, -1, 0);
              if (node.transform.rotation) {
                direction = BABYLON.Vector3.Forward().rotateByQuaternionToRef(
                  BABYLON.Quaternion.FromEulerAngles(
                    node.transform.rotation[0],
                    node.transform.rotation[1],
                    node.transform.rotation[2]
                  ),
                  new BABYLON.Vector3()
                );
              }
              light = new BABYLON.SpotLight(
                node.id,
                position,
                direction,
                lightProps.angle || Math.PI / 6,
                lightProps.exponent || 1,
                scene
              );
              if (lightProps.range !== undefined) {
                light.range = lightProps.range;
              }
              break;
            }
            case 'Directional': {
              // Compute direction from node rotation
              let direction = new BABYLON.Vector3(0, -1, 0);
              if (node.transform.rotation) {
                direction = BABYLON.Vector3.Forward().rotateByQuaternionToRef(
                  BABYLON.Quaternion.FromEulerAngles(
                    node.transform.rotation[0],
                    node.transform.rotation[1],
                    node.transform.rotation[2]
                  ),
                  new BABYLON.Vector3()
                );
              }
              light = new BABYLON.DirectionalLight(node.id, direction, scene);
              // Position directional for better shadow casting
              light.position = position;
              break;
            }
            case 'Hemispheric':
            default: {
              const direction = new BABYLON.Vector3(0, 1, 0);
              light = new BABYLON.HemisphericLight(node.id, direction, scene);
              if (lightProps.groundColor) {
                light.groundColor = new BABYLON.Color3(...lightProps.groundColor);
              }
              break;
            }
          }

          // Common light properties
          if (typeof lightProps.intensity === 'number') {
            light.intensity = lightProps.intensity;
          } else {
            light.intensity = 0.7;
          }
          if (Array.isArray(lightProps.color) && lightProps.color.length === 3) {
            light.diffuse = new BABYLON.Color3(...lightProps.color);
          }

          // Apply enabled state from node
          const lightEnabled = node.enabled !== false;
          light.setEnabled(lightEnabled);
          break;
        }

        case 'mesh':
          let mesh = null;
          
          // Check if this is a child mesh (contains ::mesh::)
          if (node.id.includes('::mesh::') && node.parentId) {
            // Child mesh - find by stableId (with legacy numeric fallback)
            const MESH_TAG = '::mesh::';
            function getChildTokenFromId(id) {
              const i = id.lastIndexOf(MESH_TAG);
              return i >= 0 ? id.slice(i + MESH_TAG.length) : null;
            }
            
            const token = getChildTokenFromId(node.id);
            if (token) {
              // Primary: find by stableId
              mesh = scene.meshes.find(m => m.metadata && m.metadata.stableId === token);

              // Legacy fallback: numeric uniqueId
              if (!mesh && /^[0-9]+$/.test(token)) {
                const uniq = parseInt(token, 10);
                mesh = scene.meshes.find(m => m.uniqueId === uniq);
              }

              if (mesh) {
                // Apply child mesh transform
                mesh.position = position;
                if (mesh.rotationQuaternion) {
                  mesh.rotationQuaternion = BABYLON.Quaternion.FromEulerAngles(rotation.x, rotation.y, rotation.z);
                } else {
                  mesh.rotation = rotation;
                }
                mesh.scaling = scaling;
              } else {
                console.warn('⚠️ RUNTIME: Child mesh not found (stableId/legacy):', node.id);
              }
            }
          } else if (node.id === 'defaultCube') {
            mesh = BABYLON.MeshBuilder.CreateBox(node.id, { size: 2 }, scene);
            mesh.position = position;
            mesh.rotation = rotation;
            mesh.scaling = scaling;
            
            // Create PBR material for better IBL visualization
            const cubeMaterial = new BABYLON.PBRMaterial('defaultCubeMaterial', scene);
            cubeMaterial.albedoColor = new BABYLON.Color3(0.8, 0.8, 0.8);
            cubeMaterial.metallic = 0.1;
            cubeMaterial.roughness = 0.3;
            mesh.material = cubeMaterial;
          } else if (node.id === 'ground') {
            mesh = BABYLON.MeshBuilder.CreateGround(node.id, { width: 6, height: 6 }, scene);
            mesh.position = position;
            mesh.rotation = rotation;
            mesh.scaling = scaling;
            
            // Create PBR material for better IBL visualization
            const groundMaterial = new BABYLON.PBRMaterial('groundMaterial', scene);
            groundMaterial.albedoColor = new BABYLON.Color3(0.5, 0.5, 0.5);
            groundMaterial.metallic = 0.0;
            groundMaterial.roughness = 0.8;
            mesh.material = groundMaterial;
          }
          
          // Apply visibility and enabled states
          if (mesh) {
            const visible = node.visible !== false;
            const enabled = node.enabled !== false;
            // For meshes, both visible and enabled use the visibility property
            mesh.visibility = (visible && enabled) ? 1 : 0;
          }
          break;

        case 'model':
          if (node.src) {
            await loadModelFromAssets(node, scene);
          }
          break;
      }
    } catch (error) {
      console.error('Failed to instantiate node ' + node.id + ':', error);
    }
  }

  async function loadModelFromAssets(node, scene) {
    if (!scene || !node.src) return;

    try {
      // Convert storage path to asset path
      const assetPath = 'assets/' + toRelativeAssetPath(node.src);
      console.log('🔗 Loading model from:', assetPath);
      
      // Load the asset container with proper rootUrl/filename for GLTF so sidecars resolve correctly
      let result = null;
      const lower = assetPath.toLowerCase();
      if (lower.endsWith('.gltf')) {
        const rootUrl = assetPath.substring(0, assetPath.lastIndexOf('/') + 1);
        const filename = assetPath.substring(assetPath.lastIndexOf('/') + 1);
        console.log('🔗 GLTF Root URL:', rootUrl);
        console.log('🔗 GLTF Filename:', filename);
        result = await BABYLON.SceneLoader.LoadAssetContainerAsync(rootUrl, filename, scene);
      } else {
        result = await BABYLON.SceneLoader.LoadAssetContainerAsync('', assetPath, scene);
      }
      
      if (result.meshes.length > 0) {
        // Create a parent transform node
        const parentNode = new BABYLON.TransformNode(node.id, scene);
        parentNode.position = new BABYLON.Vector3(...node.transform.position);
        
        if (node.transform.rotation) {
          parentNode.rotation = new BABYLON.Vector3(...node.transform.rotation);
        }
        if (node.transform.scaling) {
          parentNode.scaling = new BABYLON.Vector3(...node.transform.scaling);
        }

        // Parent all loaded meshes to the transform node
        result.meshes.forEach(mesh => {
          mesh.parent = parentNode;
        });

        // Apply visibility and enabled states with proper inheritance
        const parentVisible = node.visible !== false;
        const parentEnabled = node.enabled !== false;
        
        // PATCH: assign stableId to runtime meshes from SceneGraph children, then apply states
        const MESH_TAG = '::mesh::';
        function getChildTokenFromId(id) {
          const i = id.lastIndexOf(MESH_TAG);
          return i >= 0 ? id.slice(i + MESH_TAG.length) : null;
        }

        // 1) Gather SceneGraph child nodes of this model
        const childNodes = (EXPORTED_SCENE_GRAPH?.nodes || []).filter(n => n.parentId === node.id && n.kind === 'mesh');

        // 2) Build a deterministic map of (name, occurrenceIndex) -> { node, token }
        const sgIndex = new Map();
        {
          const nameCounts = new Map(); // lowercased name -> next index
          for (const cn of childNodes) {
            const nm = (cn.name || 'Mesh').toLowerCase();
            const idx = nameCounts.get(nm) || 0;
            nameCounts.set(nm, idx + 1);

            const token = getChildTokenFromId(cn.id) || '';
            const key = `${nm}::${idx}`;
            sgIndex.set(key, { node: cn, token });
          }
        }

        // 3) Walk runtime meshes in the same deterministic fashion
        {
          const nameCounts = new Map();
          const meshesToKeep = [];
          
          // Filter out __root__ wrapper mesh (Babylon's container mesh)
          const actualMeshes = result.meshes
            .filter(m => m instanceof BABYLON.Mesh)
            .filter(m => m.name !== "__root__");
          
          for (const mesh of actualMeshes) {
            if (!mesh.metadata) mesh.metadata = {};
            const nm = (mesh.name || 'Mesh').toLowerCase();
            const idx = nameCounts.get(nm) || 0;
            nameCounts.set(nm, idx + 1);

            const key = `${nm}::${idx}`;
            const entry = sgIndex.get(key);

            if (entry) {
              const { node: childNode, token } = entry;

              // Assign runtime stableId from graph token
              mesh.metadata.stableId = token;

              // Apply visibility/enabled with parent inheritance
              const childVisible = childNode.visible !== false;
              const childEnabled = childNode.enabled !== false;
              const effectiveVisible = childVisible && childEnabled && parentVisible && parentEnabled;

              mesh.visibility = effectiveVisible ? 1 : 0;
              meshesToKeep.push(mesh);
            } else {
              // No saved child node — this mesh was deleted, so dispose it
              console.log('🗑️ RUNTIME: Skipping deleted child mesh:', mesh.name);
              mesh.dispose();
            }
          }
          
          // Replace the meshes array with only the ones we want to keep
          result.meshes = meshesToKeep;
        }

        // Add to scene
        result.addAllToScene();

        // Start animation groups after adding to scene
        if (result.animationGroups && result.animationGroups.length > 0) {
          console.log(`🎬 Starting ${result.animationGroups.length} animation groups for ${node.name}`);
          result.animationGroups.forEach(animGroup => {
            animGroup.start(true, 1.0, animGroup.from, animGroup.to, false);
          });
          console.log('✅ Animation groups started');
        }
        
        console.log('✅ Model loaded successfully:', node.name);
      }
    } catch (error) {
      console.error('❌ Failed to load model ' + node.name + ':', error);
    }
  }

  // Fix IBL material reflections - this is what skybox creation accidentally does right!
  function refreshMaterialsForIBL(scene) {
    console.log('🔧 Applying proper IBL material refresh (fixes reflection issues)');
    scene.materials.forEach(material => {
      console.log('🔍 Material type:', material.constructor.name, 'name:', material.name);
      if (material instanceof BABYLON.PBRMaterial || material instanceof BABYLON.StandardMaterial) {
        // Clear any incorrectly applied environment textures on the material
        if (material.environmentTexture === scene.environmentTexture) {
          material.environmentTexture = null;
          console.log('🧹 Cleared incorrectly applied environment texture from:', material.name);
        }
        if (material instanceof BABYLON.PBRMaterial && material.albedoTexture === scene.environmentTexture) {
          material.albedoTexture = null;
          console.log('🧹 Cleared environment texture from albedo:', material.name);
        }
        
        material.markDirty();
        console.log('✅ Fixed IBL reflections for material:', material.name);
      } else {
        console.log('❌ Material type not supported for IBL:', material.constructor.name, material.name);
      }
    });
    console.log('🎉 IBL reflections fixed for all materials!');
  }

  // Apply scene settings to the live scene
  async function applySceneSettings(scene, settings) {
    console.log('🎨 Applying scene settings:', settings);
    
    // Environment settings
    const env = settings.environment;
    if (env) {
      // Clear color
      if (env.clearColor) {
        const [r, g, b, a] = env.clearColor;
        scene.clearColor.set(r, g, b, a);
      }
      
      // Ambient color
      if (env.ambientColor) {
        const [r, g, b] = env.ambientColor;
        scene.ambientColor.set(r, g, b);
      }
      
      // IBL (Image-Based Lighting) - AFFECTS SCENE LIGHTING & REFLECTIONS
      console.log('💡 IBL Settings (scene lighting/reflections):', { useIBL: env.useIBL, iblPath: env.iblPath, iblIntensity: env.iblIntensity });
      scene.environmentIntensity = env.iblIntensity || 1;
      
      if (env.useIBL && env.iblPath) {
        try {
          const assetPath = 'assets/' + toRelativeAssetPath(env.iblPath);
          console.log('🌍 Loading IBL for SCENE LIGHTING from asset path:', assetPath);
          
          let environmentTexture = null;
          if (assetPath.toLowerCase().endsWith('.env')) {
            console.log('📦 Loading .env IBL texture for scene lighting...');
            environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(assetPath, scene);
          } else {
            console.log('📦 Loading .hdr IBL texture for scene lighting...');
            environmentTexture = new BABYLON.HDRCubeTexture(assetPath, scene, 128, false, true, false, true);
          }
          
          if (environmentTexture) {
            // CRITICAL: This applies IBL to scene lighting and material reflections
            scene.environmentTexture = environmentTexture;
            
            // Set intensity immediately
            scene.environmentIntensity = env.iblIntensity || 1;
            
            // Wait for texture to load and then refresh materials
            environmentTexture.onLoadObservable.addOnce(() => {
              // Set intensity again after texture loads (in case it was reset)
              scene.environmentIntensity = env.iblIntensity || 1;
              console.log('✅ IBL SCENE LIGHTING loaded, intensity set to:', env.iblIntensity);
              
              // Force material refresh for existing materials - critical for IBL LIGHTING to show up
              refreshMaterialsForIBL(scene);
              console.log('✅ IBL SCENE LIGHTING fully loaded, materials refreshed, intensity:', env.iblIntensity);
            });
            
            console.log('✅ IBL SCENE LIGHTING assigned, intensity:', env.iblIntensity);
          }
        } catch (error) {
          console.error('❌ Failed to load IBL texture for scene lighting:', error);
        }
      } else {
        scene.environmentTexture = null;
        console.log('🔄 IBL disabled - cleared scene environment lighting');
      }
      
      // Fog settings
      const fm = env.fogMode;
      scene.fogMode = 
        fm === 'linear' ? BABYLON.Scene.FOGMODE_LINEAR :
        fm === 'exp'    ? BABYLON.Scene.FOGMODE_EXP    :
        fm === 'exp2'   ? BABYLON.Scene.FOGMODE_EXP2   :
                          BABYLON.Scene.FOGMODE_NONE;
    }
    
    // Image processing settings
    const ip = settings.imageProcessing;
    if (ip && scene.imageProcessingConfiguration) {
      const ipc = scene.imageProcessingConfiguration;
      
      ipc.contrast = ip.contrast || 1;
      ipc.exposure = ip.exposure || 1;
      ipc.toneMappingEnabled = !!ip.toneMappingEnabled;
      
      // Tone mapping type
      ipc.toneMappingType = 
        ip.toneMappingType === 'aces'    ? BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES :
        ip.toneMappingType === 'neutral' ? BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES : // fallback
                                           BABYLON.ImageProcessingConfiguration.TONEMAPPING_STANDARD;
      
      // Vignette settings
      ipc.vignetteEnabled = !!ip.vignetteEnabled;
      if (ip.vignetteEnabled) {
        ipc.vignetteWeight = ip.vignetteWeight || 1;
        ipc.vignetteStretch = ip.vignetteStretch || 0;
        ipc.vignetteCameraFov = ip.vignetteFov || 1.5;
        
        if (ip.vignetteColor) {
          const [r, g, b, a] = ip.vignetteColor;
          ipc.vignetteColor = new BABYLON.Color4(r, g, b, a);
        }
      }
      
      // Dithering settings
      ipc.ditheringEnabled = !!ip.ditheringEnabled;
      if ('ditheringIntensity' in ipc) {
        ipc.ditheringIntensity = ip.ditheringIntensity || 0.5;
      }
    }

    // SKYBOX - VISUAL BACKDROP ONLY (NO LIGHTING/REFLECTION EFFECTS)
    if (env && env.useSkybox) {
      console.log('🎭 Creating/Updating VISUAL skybox (backdrop only, no lighting effects)...');
      try {
        // Create or fetch skybox cube - VISUAL BACKDROP ONLY
        let skybox = scene.getMeshByID('__skybox__');
        if (!skybox) {
          skybox = BABYLON.MeshBuilder.CreateBox('skybox', { size: 1000 }, scene);
          skybox.id = '__skybox__';
          skybox.infiniteDistance = true;
          skybox.isPickable = false;
        }

        // Always use StandardMaterial for consistent behavior
        let skyboxMaterial = skybox.material;
        if (!(skyboxMaterial instanceof BABYLON.StandardMaterial)) {
          if (skyboxMaterial) skyboxMaterial.dispose();
          skyboxMaterial = new BABYLON.StandardMaterial('skyboxMaterial', scene);
        }
        skyboxMaterial.disableLighting = true; // No lighting effects
        skyboxMaterial.diffuseColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.backFaceCulling = false; // critical: render inside faces

        // Determine skybox texture mode
        const sbType = env.skyboxType || (env.skyboxPanoramaPath ? 'panoramic' : (env.skyboxTextures ? 'cube' : (env.useIBL ? 'iblFallback' : 'none')));

        // Reset any previous textures
        if (skyboxMaterial.reflectionTexture) { skyboxMaterial.reflectionTexture.dispose(); }
        skyboxMaterial.reflectionTexture = null;
        if (skyboxMaterial.diffuseTexture) { skyboxMaterial.diffuseTexture.dispose(); }
        skyboxMaterial.diffuseTexture = null;

        if (sbType === 'panoramic' && env.skyboxPanoramaPath) {
          const panoPath = 'assets/' + toRelativeAssetPath(env.skyboxPanoramaPath);
          console.log('🌄 Applying panoramic skybox:', panoPath);
          const tex = new BABYLON.Texture(panoPath, scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
          tex.coordinatesMode = BABYLON.Texture.FIXED_EQUIRECTANGULAR_MODE;
          skyboxMaterial.reflectionTexture = tex;
          skybox.isVisible = true;
        } else if (sbType === 'cube' && env.skyboxTextures) {
          const faces = env.skyboxTextures;
          const order = ['px','nx','py','ny','pz','nz'];
          if (order.every(f => faces[f])) {
            const urls = order.map(f => 'assets/' + toRelativeAssetPath(faces[f]));
            console.log('🧊 Applying cube skybox with faces:', urls);
            const cube = BABYLON.CubeTexture.CreateFromImages(urls, scene);
            cube.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
            skyboxMaterial.reflectionTexture = cube;
            skybox.isVisible = true;
          } else {
            console.warn('⚠️ Cube skybox incomplete; required px,nx,py,ny,pz,nz');
            // Fallback to IBL if available
            if (scene.environmentTexture) {
              skyboxMaterial.reflectionTexture = scene.environmentTexture;
              skyboxMaterial.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
              skybox.isVisible = true;
            } else {
              skybox.isVisible = false;
            }
          }
        } else if (sbType === 'iblFallback' && scene.environmentTexture) {
          console.log('🎭 Skybox fallback to IBL visual texture');
          skyboxMaterial.reflectionTexture = scene.environmentTexture;
          skyboxMaterial.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
          skybox.isVisible = true;
        } else {
          console.log('⚠️ Skybox type set but no texture paths provided');
          skybox.isVisible = false;
        }

        skybox.material = skyboxMaterial;
        console.log('🌌 Skybox visibility:', skybox.isVisible, 'has reflectionTexture:', !!skyboxMaterial.reflectionTexture);
      } catch (error) {
        console.error('❌ Failed to create/update visual skybox:', error);
      }
    } else {
      // Remove visual skybox if disabled
      const existingSkybox = scene.getMeshByID('__skybox__');
      if (existingSkybox) {
        existingSkybox.dispose();
        console.log('🎭 Visual skybox removed');
      }
    }
    
    console.log('✅ Scene settings applied');
  }

    // Apply material property overrides
    function applyMaterialOverrides(scene, overrides) {
    console.log('🎨 RUNTIME: Applying material overrides:', overrides);
    console.log('🔍 RUNTIME: Available materials:', scene.materials.map(m => ({ name: m.name, uniqueId: m.uniqueId })));
    
    for (const [materialName, properties] of Object.entries(overrides)) {
      // Only look for materials by name (stable identifier)
      const material = scene.materials.find(m => m.name === materialName);
      console.log('🔍 RUNTIME: Looking for material by name:', materialName, 'found:', !!material);
      
      if (material) {
        console.log('✨ RUNTIME: Applying overrides to material:', material.name, 'uniqueId:', material.uniqueId);
        console.log('✨ RUNTIME: Properties to apply:', properties);
        
        // Apply each property override
        for (const [property, value] of Object.entries(properties)) {
          try {
              console.log('🔍 RUNTIME: Processing property:', property, 'value:', value, 'isTexture:', isTextureProperty(property));
              
              if (typeof value === 'string' && isTextureProperty(property)) {
                console.log('📸 RUNTIME: Loading texture for property:', property, 'from path:', value);
                
                // Store reference to original texture before replacing
                const originalTexture = material[property];
                console.log('🔍 RUNTIME: Original texture for', property + ':', originalTexture ? (originalTexture.name || originalTexture.url) : 'none');
                if (originalTexture) {
                  console.log('🔍 RUNTIME: Original texture details:', {
                    name: originalTexture.name,
                    url: originalTexture.url,
                    coordinatesIndex: originalTexture.coordinatesIndex,
                    hasEmbeddedHash: originalTexture.url && originalTexture.url.includes('#')
                  });
                }

                // Selective override logic (mimic viewer): avoid replacing identical GLTF textures
                const currentPath = originalTexture ? (originalTexture.url || originalTexture.name || '') : '';
                const currentFile = getFilenameFromUrl(currentPath);
                const overrideFile = getFilenameFromUrl(value);
                const isEmbedded = !!(originalTexture && originalTexture.url && originalTexture.url.includes('#'));
                const shouldApplyOverride = !originalTexture || isEmbedded || (currentFile !== overrideFile && !!overrideFile);
                console.log('🔍 RUNTIME: Texture comparison for', property, { currentFile, overrideFile, isEmbedded, shouldApplyOverride });
                if (!shouldApplyOverride) {
                  console.log('🔍 RUNTIME: Keeping original GLTF texture for', property, '(', currentPath, ')');
                  continue;
                }
                
                const tex = loadTextureFromAssetPath(value, scene);
                if (tex) {
                  // CRITICAL: Copy UV channel and texture properties from original GLTF texture
                  if (originalTexture) {
                    // Copy UV channel settings (these preserve GLTF UV mapping)
                    if ('coordinatesIndex' in originalTexture && typeof originalTexture.coordinatesIndex === 'number') {
                      tex.coordinatesIndex = originalTexture.coordinatesIndex;
                      console.log('🔄 RUNTIME: Copied coordinatesIndex (UV channel):', originalTexture.coordinatesIndex);
                    }
                    
                    // Copy other important texture properties that affect UV mapping
                    if ('uOffset' in originalTexture) tex.uOffset = originalTexture.uOffset;
                    if ('vOffset' in originalTexture) tex.vOffset = originalTexture.vOffset;
                    if ('uScale' in originalTexture) tex.uScale = originalTexture.uScale;
                    if ('vScale' in originalTexture) tex.vScale = originalTexture.vScale;
                    if ('uAng' in originalTexture) tex.uAng = originalTexture.uAng;
                    if ('vAng' in originalTexture) tex.vAng = originalTexture.vAng;
                    if ('wAng' in originalTexture) tex.wAng = originalTexture.wAng;
                    
                    // Copy wrapping modes
                    if ('wrapU' in originalTexture) tex.wrapU = originalTexture.wrapU;
                    if ('wrapV' in originalTexture) tex.wrapV = originalTexture.wrapV;
                    
                    console.log('✅ RUNTIME: Copied UV properties from original texture');
                  } else {
                    // No original texture to copy from (might be embedded or first time assignment)
                    // Set reasonable defaults for common texture types
                    if (property === 'ambientTexture' || property === 'lightmapTexture') {
                      // Ambient/lightmap textures typically use UV2 (coordinatesIndex 1)
                      tex.coordinatesIndex = 1;
                      console.log('🔄 RUNTIME: Set default UV channel for', property + ': 1 (UV2)');
                    } else {
                      // Most other textures use UV1 (coordinatesIndex 0)
                      tex.coordinatesIndex = 0;
                      console.log('🔄 RUNTIME: Set default UV channel for', property + ': 0 (UV1)');
                    }
                  }
                  
                  material[property] = tex;
                  console.log('✅ RUNTIME: Applied texture to material:', materialName + '.' + property, 'with UV channel:', tex.coordinatesIndex);
                } else {
                  console.warn('❌ RUNTIME: Skipping texture override due to load failure:', property, value);
                }
              } else {
                material[property] = value;
                console.log('✅ RUNTIME: Applied non-texture property:', materialName + '.' + property + ' = ' + value);
              }
            
            // Handle wireframe for materials that aren't ready yet (common with imported assets)
            if (property === 'wireframe' && material.isReady && !material.isReady()) {
              console.log('🔧 Runtime material ' + materialName + ' not ready (likely imported asset), re-applying wireframe after delay...');
              
              // For imported materials, re-apply wireframe after a short delay
              setTimeout(function() {
                try {
                  material.wireframe = value;
                  console.log('✅ Re-applied wireframe to imported material ' + materialName + ': ' + value);
                } catch (e) {}
              }, 200);
            }
          } catch (error) {
            console.warn('Failed to apply material override ' + property + ':', error);
          }
        }
      } else {
        console.warn('❌ Material not found for override:', materialName);
        console.log('Available material names:', scene.materials.map(m => m.name));
      }
    }
  }

  // Convert storage path to relative asset path (preserve folders after '/assets/' or after '/projects/<id>/')
  function toRelativeAssetPath(storagePath) {
    const pathStr = String(storagePath);
    // 1) If contains '/assets/', keep everything after it
    const assetsMarker = '/assets/';
    const idx = pathStr.indexOf(assetsMarker);
    if (idx >= 0) {
      return pathStr.substring(idx + assetsMarker.length);
    }
    // 2) If looks like '<uid>/projects/<projectId>/...'
    const parts = pathStr.split('/');
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && parts.length > projIdx + 2) {
      const after = parts.slice(projIdx + 2).join('/');
      if (after) return after;
    }
    // 3) Fallback to filename
    const filename = parts[parts.length - 1];
    if (filename) return filename;
    // 4) Ultimate fallback: sanitize path without regex
    return pathStr.split('/').join('_').split('\\').join('_');
  }

})();