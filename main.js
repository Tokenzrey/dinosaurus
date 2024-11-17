import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.124/build/three.module.js";

import { player } from "./player.js";
import { world } from "./world.js";
import { background } from "./background.js";

const _VS = `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const _FS = `
uniform vec3 topColor;
uniform vec3 bottomColor;
uniform float offset;
uniform float exponent;
varying vec3 vWorldPosition;
void main() {
  float h = normalize( vWorldPosition + offset ).y;
  gl_FragColor = vec4( mix( bottomColor, topColor, max( pow( max( h , 0.0), exponent ), 0.0 ) ), 1.0 );
}`;

const _PCSS = `
#define LIGHT_WORLD_SIZE 0.05
#define LIGHT_FRUSTUM_WIDTH 3.75
#define LIGHT_SIZE_UV (LIGHT_WORLD_SIZE / LIGHT_FRUSTUM_WIDTH)
#define NEAR_PLANE 1.0

#define NUM_SAMPLES 17
#define NUM_RINGS 11
#define BLOCKER_SEARCH_NUM_SAMPLES NUM_SAMPLES
#define PCF_NUM_SAMPLES NUM_SAMPLES

vec2 poissonDisk[NUM_SAMPLES];

void initPoissonSamples( const in vec2 randomSeed ) {
  float ANGLE_STEP = PI2 * float( NUM_RINGS ) / float( NUM_SAMPLES );
  float INV_NUM_SAMPLES = 1.0 / float( NUM_SAMPLES );

  // jsfiddle that shows sample pattern: https://jsfiddle.net/a16ff1p7/
  float angle = rand( randomSeed ) * PI2;
  float radius = INV_NUM_SAMPLES;
  float radiusStep = radius;

  for( int i = 0; i < NUM_SAMPLES; i ++ ) {
    poissonDisk[i] = vec2( cos( angle ), sin( angle ) ) * pow( radius, 0.75 );
    radius += radiusStep;
    angle += ANGLE_STEP;
  }
}

float penumbraSize( const in float zReceiver, const in float zBlocker ) { // Parallel plane estimation
  return (zReceiver - zBlocker) / zBlocker;
}

float findBlocker( sampler2D shadowMap, const in vec2 uv, const in float zReceiver ) {
  // This uses similar triangles to compute what
  // area of the shadow map we should search
  float searchRadius = LIGHT_SIZE_UV * ( zReceiver - NEAR_PLANE ) / zReceiver;
  float blockerDepthSum = 0.0;
  int numBlockers = 0;

  for( int i = 0; i < BLOCKER_SEARCH_NUM_SAMPLES; i++ ) {
    float shadowMapDepth = unpackRGBAToDepth(texture2D(shadowMap, uv + poissonDisk[i] * searchRadius));
    if ( shadowMapDepth < zReceiver ) {
      blockerDepthSum += shadowMapDepth;
      numBlockers ++;
    }
  }

  if( numBlockers == 0 ) return -1.0;

  return blockerDepthSum / float( numBlockers );
}

float PCF_Filter(sampler2D shadowMap, vec2 uv, float zReceiver, float filterRadius ) {
  float sum = 0.0;
  for( int i = 0; i < PCF_NUM_SAMPLES; i ++ ) {
    float depth = unpackRGBAToDepth( texture2D( shadowMap, uv + poissonDisk[ i ] * filterRadius ) );
    if( zReceiver <= depth ) sum += 1.0;
  }
  for( int i = 0; i < PCF_NUM_SAMPLES; i ++ ) {
    float depth = unpackRGBAToDepth( texture2D( shadowMap, uv + -poissonDisk[ i ].yx * filterRadius ) );
    if( zReceiver <= depth ) sum += 1.0;
  }
  return sum / ( 2.0 * float( PCF_NUM_SAMPLES ) );
}

float PCSS ( sampler2D shadowMap, vec4 coords ) {
  vec2 uv = coords.xy;
  float zReceiver = coords.z; // Assumed to be eye-space z in this code

  initPoissonSamples( uv );
  // STEP 1: blocker search
  float avgBlockerDepth = findBlocker( shadowMap, uv, zReceiver );

  //There are no occluders so early out (this saves filtering)
  if( avgBlockerDepth == -1.0 ) return 1.0;

  // STEP 2: penumbra size
  float penumbraRatio = penumbraSize( zReceiver, avgBlockerDepth );
  float filterRadius = penumbraRatio * LIGHT_SIZE_UV * NEAR_PLANE / zReceiver;

  // STEP 3: filtering
  //return avgBlockerDepth;
  return PCF_Filter( shadowMap, uv, zReceiver, filterRadius );
}
`;

const _PCSSGetShadow = `
return PCSS( shadowMap, shadowCoord );
`;

class BasicWorldDemo {
	constructor() {
		this._Initialize();

		this._gameStarted = false;
		this._gameOver = false;
		this._currentCharacter = "Velociraptor";

		// Event handlers for buttons
		document.getElementById("play-button").onclick = () => this._OnStart();
		document.getElementById("replay-button").onclick = () => this._OnReplay();
		document
			.getElementById("character-select")
			.addEventListener("change", (e) => this._OnCharacterSelect(e));
	}

	_OnStart() {
		// Update character from the dropdown selection
		this._currentCharacter = document.getElementById("character-select").value;

		// Reinitialize player with selected character
		this._ResetPlayer();

		// Hide the game menu and start the game
		document.getElementById("game-menu").style.display = "none";
		this._gameStarted = true;
	}

	_OnCharacterSelect(event) {
		this._currentCharacter = event.target.value;
		console.log("Selected character:", this._currentCharacter);
	}

	_OnReplay() {
		// Update character from the dropdown selection
		this._currentCharacter = document.getElementById("character-select").value;

		// Hide the game-over panel and reset the game
		document.getElementById("game-over").classList.remove("active");
		this._ResetGame();
		this._gameStarted = true;
	}

	_ResetPlayer() {
		// Remove the previous player and reinitialize with the selected character
		if (this.player_) {
			this.scene_.remove(this.player_.mesh_);
		}

		this.player_ = new player.Player({
			scene: this.scene_,
			world: this.world_,
			character: this._currentCharacter, // Pass the selected character
		});
	}
  
	_ResetGame() {
		// Reinitialize the world, player, and background
		this.scene_.clear(); // Clear all objects from the scene
		this._InitializeScene(); // Reinitialize the scene elements
		this._gameOver = false;
	}

	_Initialize() {
		// Renderer setup
		this.threejs_ = new THREE.WebGLRenderer({
			antialias: true,
		});
		this.threejs_.outputEncoding = THREE.sRGBEncoding;
		this.threejs_.shadowMap.enabled = true;
		this.threejs_.setPixelRatio(window.devicePixelRatio);
		this.threejs_.setSize(window.innerWidth, window.innerHeight);

		document.getElementById("container").appendChild(this.threejs_.domElement);

		window.addEventListener("resize", () => this.OnWindowResize_(), false);

		// Initialize the scene
		this.scene_ = new THREE.Scene();
		this.camera_ = new THREE.PerspectiveCamera(60, 1920 / 1080, 1.0, 20000.0);
		this.camera_.position.set(-5, 5, 10);
		this.camera_.lookAt(8, 3, 0);

		this._InitializeScene();
		this.previousRAF_ = null;
		this.RAF_();
	}

	_InitializeScene() {
		// Reset background, lighting, and other game objects

		// Lighting
		this.scene_.background = new THREE.Color(0x808080);
		this.scene_.fog = new THREE.FogExp2(0x89b2eb, 0.00125);

		let light = new THREE.DirectionalLight(0xffffff, 1.0);
		light.position.set(60, 100, 10);
		light.target.position.set(40, 0, 0);
		light.castShadow = true;
		light.shadow.bias = -0.001;
		light.shadow.mapSize.width = 4096;
		light.shadow.mapSize.height = 4096;
		light.shadow.camera.far = 200.0;
		light.shadow.camera.near = 1.0;
		light.shadow.camera.left = 50;
		light.shadow.camera.right = -50;
		light.shadow.camera.top = 50;
		light.shadow.camera.bottom = -50;
		this.scene_.add(light);

		light = new THREE.HemisphereLight(0x202020, 0x004080, 0.6);
		this.scene_.add(light);

		// Ground
		const ground = new THREE.Mesh(
			new THREE.PlaneGeometry(20000, 20000, 10, 10),
			new THREE.MeshStandardMaterial({ color: 0xf6f47f })
		);
		ground.castShadow = false;
		ground.receiveShadow = true;
		ground.rotation.x = -Math.PI / 2;
		this.scene_.add(ground);

		// Sky
		const uniforms = {
			topColor: { value: new THREE.Color(0x0077ff) },
			bottomColor: { value: new THREE.Color(0x89b2eb) },
			offset: { value: 33 },
			exponent: { value: 0.6 },
		};
		const skyGeo = new THREE.SphereBufferGeometry(1000, 32, 15);
		const skyMat = new THREE.ShaderMaterial({
			uniforms: uniforms,
			vertexShader: _VS,
			fragmentShader: _FS,
			side: THREE.BackSide,
		});
		this.scene_.add(new THREE.Mesh(skyGeo, skyMat));

		// Reinitialize world, player, and background
		this.world_ = new world.WorldManager({ scene: this.scene_ });
		this.player_ = new player.Player({
			scene: this.scene_,
			world: this.world_,
			character: this._currentCharacter,
		});
		this.background_ = new background.Background({ scene: this.scene_ });
	}

	OnWindowResize_() {
		this.camera_.aspect = window.innerWidth / window.innerHeight;
		this.camera_.updateProjectionMatrix();
		this.threejs_.setSize(window.innerWidth, window.innerHeight);
	}

	RAF_() {
		requestAnimationFrame((t) => {
			if (this.previousRAF_ === null) {
				this.previousRAF_ = t;
			}

			this.RAF_();

			this.Step_((t - this.previousRAF_) / 1000.0);
			this.threejs_.render(this.scene_, this.camera_);
			this.previousRAF_ = t;
		});
	}

	Step_(timeElapsed) {
		if (!this._gameStarted || this._gameOver) {
			return;
		}

		this.player_.Update(timeElapsed);
		this.world_.Update(timeElapsed);
		this.background_.Update(timeElapsed);

		if (this.player_.gameOver && !this._gameOver) {
			this._gameOver = true;
			document.getElementById("game-over").classList.add("active");
		}
	}
}

let _APP = null;

window.addEventListener("DOMContentLoaded", () => {
	_APP = new BasicWorldDemo();
});
