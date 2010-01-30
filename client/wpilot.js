//
//  wpilot.js
//  Web browser WPilot client
//  
//  Read README for instructions and LICENSE license.
//  
//  Copyright (c) 2010 Johan Dahlberg 
//
var CLIENT_VERSION = '(develop version)';

var _ = Match.incl;

var GRID_CELL_SIZE      = 250;
    GRID_CELL_COLOR     = 'rgba(255,255,255,0.2)';
    
// GUI Fonts used in the client.
var HUD_SMALL_FONT      = 'bold 9px Arial',
    HUD_LARGE_FONT      = 'bold 11px Arial',
    HUD_XLARGE_FONT      = 'bold 16px Arial',
    HUD_WHITE_COLOR     = 'rgba(255,255,255,0.8)',
    HUD_GREY_COLOR      = 'rgba(255,255,255,0.4)';
    HUD_MESSAGE_SMALL   = 0,
    HUD_MESSAGE_LARGE   = 1;

// Message log related constants.
var LOG_AGE_LIMIT       = 100,
    LOG_HISTORY_COUNT   = 20,
    LOG_FONT            = '9px Arial',
    LOG_COLOR           = 'rgba(255,255,255,0.4)';

var SHIP_FONT           = '9px Arial';

// WPilotClient states
var CLIENT_DISCONNECTED     = 0,
    CLIENT_CONNECTING       = 1,
    CLIENT_CONNECTED        = 2;

// Default client options. This options can be changed from the console
// by typing wpilot.options[OPTION_NAME] = new_value
var DEFAULT_OPTIONS         = {
  max_fps:              100,
  show_fps:             true,
  
  show_netstat:         false, 

  hud_player_score_v:   true,
  hud_player_name_v:    true,
  hud_player_pos_v:     true,
  hud_coords_v:         true,
  hud_energy_v:         true,
  
  log_max_messages:     3,
  log_msg_lifetime:     5000,
  log_console:          true,
  
  bindings: {
    'ready':            82,
    'rotate_west':      37,
    'rotate_east':      39,
    'thrust':           38,
    'shoot':            32,
    'shield':           40
  }
}

/**
 *  Represents the WPilot client.
 */
function WPilotClient(options) {
  this.options            = options;
  
  this.viewport           = null;
  this.input              = null;
  this.world              = null;
  this.player             = null;
  this.conn               = null;
  this.message_log        = [];
  this.hud_message        = null;
  this.hud_message_type   = HUD_MESSAGE_SMALL;
  this.respawn_at         = 0;

  this.netstat            = { 
    start_time:         null,
    frequence:          0.4,
    last_update:        0,
    last_received:      0, 
    bytes_received:     0, 
    bytes_sent:         0,
    bps_in:             0,
    bps_out:            0,
    peek_in:            0,
    peek_out:           0,
    messages_received:  0,
    messages_sent:      0,
    mps_in:             0,
    mps_out:            0,
  };
  
  // Status variables
  this.state              = CLIENT_DISCONNECTED;
  this.server_state       = null;
  this.handshaked         = false;
  this.is_connected       = false;
  this.disconnect_reason  = null;
  
  // Event callbacks
  this.onconnect          = function() {};
  this.ondisconnect       = function() {};
  
  this.log('Welcome to WPilot ' + CLIENT_VERSION);
}

/**
 *  Writes a message to the message log.
 *  @param {String} The message string
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.log = function(msg) {
  var buffer = this.message_log, 
      time   = get_time() + this.options.log_msg_lifetime;
  if (buffer.length > LOG_HISTORY_COUNT) {
    buffer.shift();
  }
  buffer.push({ text: msg, time: time, disposed: false });
  if (this.options.log_console && window.console) console.log(msg);
}

/**
 *  Sets the world data
 *  @param {World} world The World instance
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.set_world = function(world) {
  this.world = world;
  this.log('World data loaded...');
}

/**
 *  Set the viewport to use for this WPilotClient instance.
 *  @param {Viewport} viewport The Viewport instance.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.set_viewport = function(viewport) {
  var self = this;
  viewport.ondraw = function() {
    if (self.player) {
      if (self.player.entity) {
        viewport.set_camera_pos(self.player.entity.pos);
      }
      self.world.draw(viewport);
      self.draw_hud();
    }
    self.draw_logs();
  }
  this.viewport = viewport;
}

/**
 *  Set the Input Device
 *  @param {InputDevice} device The Input Device instance.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.set_input = function(device) {
  this.input = device;
}

/**
 *  Sets the player data
 *  @param {Player} player The player instance
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.set_player = function(player) {
  player.is_me = true;
  this.player = player;
  this.log('You are now known as "' + player.name  + '"...');
}

WPilotClient.prototype.set_server_state = function(state) {
  if (state.no_players != state.max_players) {
    this.server_state = state;
    this.log('Recived server state, now joining game...');
    this.post_control_packet([CLIENT + CONNECT]);
  } else {
    this.log('Server is full');
  }
}

/**
 *  Sets the state of the Client instance
 *  @param {Number} state The new state.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.set_state = function(state) {
  switch(state) {

    case CLIENT_CONNECTING:
      this.log('Server found, now joining game...');
      this.onconnect();
      break;

    case CLIENT_CONNECTED:
      this.log('Joined server ' + this.conn.URL + '...');
      this.hud_message = 'Waiting for more players to connect';
      this.post_control_packet([CLIENT + HANDSHAKE]);  
      break;
      
    case CLIENT_DISCONNECTED:    
      this.conn = null;
      this.is_connected = false;
      this.handshaked = false;
      this.ondisconnect(this.disconnect_reason);
      this.stop_gameloop();
      
      this.log('You where disconnected from server ' +
                this.disconnect_reason ? '(Reason: ' + this.disconnect_reason + ').' :
                '');
      break;
    
  }
  this.state = state;
}

/**
 *  Starts the gameloop
 *  @param {Number} initial_tick The tick to start on (synced with server).
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.process_user_input = function(t, dt) {
  var player        = this.player,
      input         = this.input,
      new_commands  = 0;

  if (input.toggle('ready')) {
    this.post_game_packet([CLIENT + COMMAND, READY]);
  } 

  if (player.entity && !player.entity.dead && !player.entity.spawning) {
    if (input.on('thrust')) new_commands |= THRUST;
    if (input.on('rotate_west')) new_commands |= ROTATE_W;
    if (input.on('rotate_east')) new_commands |= ROTATE_E;
    if (input.on('shoot')) new_commands |= SHOOT;
    if (input.on('shield')) new_commands |= SHIELD;
  } else {
    new_commands = 0;
  }

  if (new_commands != player.commands) {
    player.commands = new_commands;
    this.post_game_packet([CLIENT + COMMAND, new_commands]);
  }
  
}

/**
 *  Starts the gameloop
 *  @param {Number} initial_tick The tick to start on (synced with server).
 *  @return {GameLoop} The newly created gameloop
 */
WPilotClient.prototype.start_gameloop = function(initial_tick) {
  var self          = this,
      player_entity = self.player.entity,
      world         = self.world,
      viewport      = self.viewport;
      
  var gameloop = new GameLoop(initial_tick);

  // Is called on each game tick.
  gameloop.ontick = function(t, dt) {
    self.process_user_input(t, dt);
    self.world.update(t, dt);
    self.remove_destroyed_entites();
  }
  
  // Is called when loop is about to start over.
  gameloop.ondone = function(t, dt, alpha) {
    self.update_client(t, dt);
    self.update_netstat(t, dt);
    viewport.refresh(alpha);
  }

  this.viewport.set_autorefresh(false);
  this.netstat.start_time = this.netstat.last_update = this.netstat.last_received = get_time();
  gameloop.start();
  self.gameloop = gameloop;
  return gameloop;
}

/**
 *  Kills the game loop. 
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.stop_gameloop = function() {
  if (this.gameloop) {
    this.gameloop.kill();
    this.gameloop = null;
    this.viewport.set_autorefresh(true);
  }
}

/**
 *  Removes all dead entities in the world.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.remove_destroyed_entites = function() {
  for (var entity_id in this.world.entities) {
    var entity = this.world.entities[entity_id];
    if (entity.destroyed) {
      if (entity && entity.player) {
        entity.player.entity = null;
      }
      this.world.delete_entity_by_id(entity_id);
    }
  }
}

/**
 *  Joins a game server. 
 *  @param {String} url Server URL.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.join = function(url) {
  var self = this;
  
  if (!self.is_connected) {
    self.disconnect_reason = 'Unknown reason';
    this.log('Trying to join server at ' + url + '...');
    self.conn = new WebSocket(url);

    /**
     *  Override the onopen event of the WebSocket instance.
     *  @param {WebSocketEvent} event The websocket event object.
     *  @returns {undefined} Nothing
     */
    self.conn.onopen = function(event){
      self.is_connected = true;
    };

    /**
     *  Override the onmessage event of the WebSocket instance.
     *  @param {WebSocketEvent} event The websocket event object.
     *  @returns {undefined} Nothing
     */
    self.conn.onmessage = function(event) {
      var packet = JSON.parse(event.data);
      
      switch (packet[0]) {
        
        case CONTROL_PACKET:
          process_control_message([packet[1], self]);
          break;
          
        case GAME_PACKET:
          var server_alpha = packet[1],
              messages = packet[2];

          if (self.netstat.start_time) {
            var now = get_time(),
                alpha = 0;//server_alpha;
            if (self.netstat.last_received) {
              var diff = now - self.netstat.last_received;
              console.log(diff);
              self.netstat.last_received = now;
            }
            self.netstat.last_received = now;
            self.netstat.bytes_received += event.data.length;
            self.netstat.messages_received += 1;
          }
          
          for (var i = 0; i < messages.length; i++) {
            process_game_message([messages[i], self]);
          }
        
          break;
          
        default:
          self.log('Recived bad packet header');
          break;
      }

    }

    /**
     *  Override the onclose event of the WebSocket instance.
     *  @param {WebSocketEvent} event The websocket event object.
     *  @returns {undefined} Nothing
     */
    self.conn.onclose = function(event){
      self.set_state(CLIENT_DISCONNECTED);
    };
    
    this.set_state(CLIENT_CONNECTING);
  }

}

/**
 *  Leaves the game server, if connected to one
 *  @param {String} reason A reason why leaving
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.leave = function(reason) {
  this.disconnect_reason = reason;
  this.conn.close();
}

/**
 *  Post a game packet to server 
 *  @param {String} msg The message that should be sent.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.post_game_packet = function(msg) {
  var packet = JSON.stringify([GAME_PACKET, msg]);
  if (this.netstat.start_time) {
    this.netstat.bytes_sent += packet.length;
    this.netstat.messages_sent += 1;
  }
  this.conn.send(packet);
}

/**
 *  Post a control packet to server 
 *  @param {String} msg The message that should be sent.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.post_control_packet = function(msg) {
  var packet = JSON.stringify([CONTROL_PACKET, msg]);
  this.conn.send(packet);
}


/**
 *  Draws logs, which includes the message log, netstat log and fps counter.
 *  @param {String} msg The message that should be sent.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.draw_logs = function() {
  var ctx             = this.viewport.ctx,
      log             = this.message_log,
      log_index       = log.length,
      log_count       = 0,
      log_x           = 5,
      log_y           = this.viewport.h + 7,
      current_time    = get_time(),
      max             = this.options.log_max_messages;
  
  ctx.font = LOG_FONT;
  while (log_index-- && ((log.length - 1) - log_index < max)) {
    var msg = log[log_index];
    if (!msg.disposed) {
      var alpha = msg.time > current_time ? 0.8 :
           0.8 + (0 - ((current_time - msg.time) / 1000));
      if (alpha < 0.02) {
        msg.disposed = true;
      } 
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      draw_label(ctx, log_x, (log_y -= 12), msg.text, 'left');
    }
  }  
  
  if (this.options.show_netstat && this.netstat.start_time) {
    ctx.fillStyle = LOG_COLOR;
    var in_kps = round_number(this.netstat.bps_in / 1024, 2);
    var out_kps = round_number(this.netstat.bps_out / 1024, 2);
    var in_mps = round_number(this.netstat.mps_in, 2);
    var out_mps = round_number(this.netstat.mps_out, 2);
    var text = 'Netstat: in: ' + in_kps + 'kb/s, out: ' + out_kps + 'kb/s, ' +
               'in: ' + in_mps + '/mps, out: ' + out_mps + '/mps';
    draw_label(ctx, 6, 12, text, 'left');
  }
  
  if (this.options.show_fps) {
    ctx.font = LOG_FONT;
    ctx.fillStyle = LOG_COLOR;
    draw_label(ctx, this.viewport.w - 6, 12, 'FPS count: ' + parseInt(this.viewport.average_fps), 'right');
  }
}

/**
 *  Draws the player HUD.
 *  @param {String} msg The message that should be sent.
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.draw_hud = function() {
  var viewport        = this.viewport,
      ctx             = viewport.ctx,
      center_w        = viewport.w / 2,
      center_h        = viewport.h / 2,
      player_entity   = this.player.entity,
      opt             = this.options;
  
  if (player_entity && !player_entity.dead) {
    ctx.textAlign = 'center';

    ctx.font = HUD_SMALL_FONT;
    
    if(opt.hud_player_score_v) {
      var limit = this.world.r_state == 'waiting' ? '-' : this.server_state.rules.round_limit;
      ctx.fillStyle = HUD_GREY_COLOR;
      draw_label(ctx, center_w + 72, center_h + 55, 'Score: ' + this.player.score + '/' + limit, 'right', 45);
    }

    if (opt.hud_player_name_v) {
      ctx.fillStyle = HUD_WHITE_COLOR;
      draw_label(ctx, center_w - 72, center_h - 45, this.player.name, 'left', 100);
    }

    if (opt.hud_player_pos_v) {
      var my_pos = this.player.pos;
      var max_pos = this.server_state.no_players;
      ctx.fillStyle = HUD_WHITE_COLOR;
      draw_label(ctx, center_w + 72, center_h - 45, 'Pos ' + my_pos + '/' + max_pos, 'right', 45);
    }
    
    if (opt.hud_coords_v)  {
      ctx.fillStyle = HUD_GREY_COLOR;
      draw_label(ctx, center_w - 72, center_h + 55, parseInt(player_entity.pos[0]) + ' x ' + parseInt(player_entity.pos[1]));
    }    
    
    if (opt.hud_energy_v) {
      draw_v_bar(ctx, center_w + 62, center_h - 37, 7, 78, this.player.energy);
    }    
  }
  
  if (player_entity && !player_entity.destroyed) {
    ctx.save();
    ctx.translate(center_w, center_h);
    player_entity.draw(ctx);
    ctx.restore();    
  }
  
  // Draw HUD message
  // Fixme: Find a better way to cycle between alpha values
  if (this.hud_message) {
    ctx.fillStyle = 'rgb(255, 215, 0)';
    if (this.hud_message_type == HUD_MESSAGE_LARGE) {
      ctx.font = HUD_XLARGE_FONT;
      draw_label(ctx, center_w, center_h, this.hud_message, 'center', 400);
    } else {
      ctx.font = HUD_LARGE_FONT;
      draw_label(ctx, center_w, viewport.h - 50, this.hud_message, 'center', 100);
    }
  }

}

WPilotClient.prototype.update_client = function(t, dt) {
  var world   = this.world,
      player  = this.player,
      server  = this.server_state,
      no      = 0,
      sec     = dt * 60;
  
  switch(world.r_state) {
    case ROUND_WAITING:
      this.hud_message_type = HUD_MESSAGE_SMALL;
      if (server.no_players == 1) {
        this.hud_message = 'Waiting for more players to join...';
      } else if (player.st != READY) {
        this.hud_message = 'Press (r) when ready';
      } else {
        no = Math.ceil((server.no_players * 0.6) - server.no_ready_players);
        this.hud_message = 'Waiting for ' + no + ' player' + (no == 1 ? '' : 's') + ' to press ready';
      }
      break;

    case ROUND_STARTING:
      server.no_ready_players = 0;
      no = parseInt((world.r_start_at - t) / sec);
      this.hud_message_type = HUD_MESSAGE_LARGE;
      if (no == 0) {
        this.hud_message = 'Prepare your self...';
      } else {
        this.hud_message = 'Round starts in ' + no + ' sec';
      }
      break;

    case ROUND_RUNNING:
      if (!player.entity) {
        if (!this.respawn_at) {
          this.respawn_at = t + server.rules.respawn_time * dt;
        } 
        no = parseInt((this.respawn_at - t) / sec); 
        this.hud_message_type = HUD_MESSAGE_SMALL;
        if (no == 0) {
          this.hud_message = 'Prepare your self...';
        } else {
          this.hud_message = 'Respawn in ' + no + ' sec';
        }
      } else {
        this.hud_message = '';
      }
      break;

    case ROUND_FINISHED:
      if (!world.winners) {
        var winners = [];
        for (var i = 0; i < world.r_winners.length; i++) {
          winners.push(world.players[world.r_winners[i]].name);
        }
        world.winners = winners.join(',');
      }
      this.hud_message_type = HUD_MESSAGE_LARGE;
      no = parseInt((world.r_restart_at - t) / sec);
      if (no == 0) {
        this.hud_message = 'Starting warm-up round';
      } else {
        this.hud_message = 'Round won by ' + world.winners  + '. New round starts in ' + no + ' sec';
      }
      break;
    
  }
}

/**
 *  Updates the netstat object
 *  @return {undefined} Nothing
 */
WPilotClient.prototype.update_netstat = function() {
  var netstat = this.netstat;
  if (netstat.start_time) {
    var now = get_time();
    if (now - netstat.last_update >= 1000) {
      var diff = now - netstat.last_update - 1000;
      var secs = ((now - netstat.start_time) / 1000) + (diff / 1000);
      var fa = netstat.frequence;
      var fb = 1 - netstat.frequence;
      netstat.last_update = now + diff;
      netstat.bps_in = fa * netstat.bps_in + fb * netstat.bytes_received / secs;
      netstat.bps_out = fa * netstat.bps_out + fb * netstat.bytes_sent / secs;
      netstat.mps_in = fa * netstat.mps_in + fb * netstat.messages_received / secs;
      netstat.mps_out = fa * netstat.mps_out + fb * netstat.messages_sent / secs;
      netstat.peek_in = netstat.bps_in > netstat.peek_in ? netstat.bps_in : netstat.peek_in;
      netstat.peek_out = netstat.bps_out > netstat.peek_out ? netstat.bps_out : netstat.peek_out;
    }
  }
}

/**
 *  Represents a keyboard device. 
 *  @param {DOMElement} target The element to read input from.
 *  @param {Object} options Options with .bindings
 */
function Keyboard(target, options) {
  var key_states = this.key_states = {};
  this.target = target;
  this.bindings = options.bindings
  
  for (var i=16; i < 128; i++) {
    key_states[i] = 0;
  }
  
  key_states['shift'] = 0;
  key_states['ctrl'] = 0;
  key_states['alt'] = 0;
  key_states['meta'] = 0;
  
  target.onkeydown = function(e) {
    if(key_states[e.keyCode] == 0) key_states[e.keyCode] = 1;
  };

  target.onkeyup = function(e) {
    if(key_states[e.keyCode] == 1) key_states[e.keyCode] = 0;
  };
}

/**
 *  Returns current state of a defined key
 *  @param {String} name Name of defined key
 *  @return {NUmber} 1 if down else 0.
 */
Keyboard.prototype.on = function(name) {
  var key = this.bindings[name];
  return this.key_states[key];
}

/**
 *  Returns current state of a defined key. The key is reseted/toggled if state
 *  is on.
 *  @param {String} name Name of defined key
 *  @return {NUmber} 1 if down else 0.
 */
Keyboard.prototype.toggle = function(name) {
  var key = this.bindings[name];
  if (this.key_states[key]) {
    this.key_states[key] = 0;
    return 1;
  }
  return 0;
}

/**
 *  Represents a canvas Viewport.
 *  @param {DOMElement} target The canvas element 
 *  @param {Number} width The width of the viewport
 *  @param {Number} height The height of the viewport
 */
function Viewport(target, width, height, options) {
  this.target       = target;
  this.ctx          = target.getContext('2d');
  this.camera       = { pos: [0, 0], size: [0, 0], scale: 1};
  this.w            = width;
  this.h            = height;
  this.options      = options;
  this.world        = {};
  this.factor       = null;
  this.autorefresh  = false;
  this.frame_skip   = 1;
  this.frame_count  = 0;
  this.frame_time   = 0;
  this.current_fps  = 0;
  this.average_fps  = 0;
  this.refresh_count = 0;

  // Event callbacks
  this.ondraw       = function() {};
  
  // Set canvas width and height
  target.width        = width;
  target.height       = height;
  
  // Start to draw things
  this.set_autorefresh(true);
}

/**
 *  Moves the camera focus to the specified point. 
 *  @param {x, y} A point representing the position of the camera
 *  @returns {undefined} Nothing
 */
Viewport.prototype.set_autorefresh = function(autorefresh) {
  var self  = this;
  if (autorefresh != self.autorefresh) {
    self.autorefresh = autorefresh;
    self.frame_time = get_time();
    if (autorefresh) {
      function loop() {
        self.refresh(0);
        if (self.autorefresh) setTimeout(loop, 1);
      }
      loop();
    } 
  }
}

/**
 *  Moves the camera focus to the specified point. 
 *  @param {Vector} A vector representing the position of the camera
 *  @returns {undefined} Nothing
 */
Viewport.prototype.set_camera_pos = function(vector) {
  this.camera.pos = [vector[0] - (this.w / 2), vector[1] - (this.h / 2)];
  this.camera.size = [this.w, this.h];
  this.camera.scale = 1;
}

Viewport.prototype.get_camera_box = function() {
  return {
    x: this.camera.pos[0],
    y: this.camera.pos[1],
    w: this.camera.size[0],
    h: this.camera.size[1]
  }
}


/**
 *  Moves the camera focus to the specified point. 
 *  @param {x, y} A point representing the position of the camera
 *  @returns {undefined} Nothing
 */
Viewport.prototype.set_world = function(world) {
  this.world = world
}
  
/**
 *  Translate a point into a camera pos.
 *  @param {Vector} The point that should be translated into camera pos
 *  @return The translated Point
 */
Viewport.prototype.translate = function(vector) {
  return vector_sub(vector, this.camera.pos);
}

/**
 *  If necessary, refreshes the view.
 *
 *  FIXME: Need a better solution for frame skipping (if possible in JS).. 
 *         frame_skip +- 0 isnt good enough
 *  @param {Number} alpha A alpha number that can be used for interpolation
 *  @return {undefined} Nothing
 */
Viewport.prototype.refresh = function(alpha) {
  var time    = get_time(),
      diff    = time - this.frame_time,
      max_fps = this.options.max_fps;
  
  if (this.refresh_count % this.frame_skip == 0) {
    this.draw();
    this.frame_count++;
  } 
  
  if (diff > 100) {
    this.current_fps = this.current_fps * 0.9 + (diff / 10) * this.frame_count * 0.1;
    
    if (this.current_fps > (max_fps)) {
      this.frame_skip += 1;
    } else if (this.frame_skip > 1 && this.current_fps < (max_fps)) {
      this.frame_skip -= 1;
    }
    
    this.frame_time = time;
    this.frame_count = 0;
    this.average_fps = this.current_fps;
  }
  
  this.refresh_count++;
}

/**
 *  Draws the scene.
 *  @return {undefined} Nothing
 */
Viewport.prototype.draw = function() {
  var ctx = this.ctx;
  ctx.clearRect(0, 0, this.w, this.h);
  ctx.save();
  ctx.translate(0, 0);
  this.ondraw(ctx);
  ctx.restore();
}

/**
 *  Processes control message recieved from server.
 *  
 */
var process_control_message = Match (
  /**
   *  The first message recieved from server on connect. Contains the 
   *  state of the server. 
   */
  [[SERVER + STATE, Object], _], 
  function(state, client) {
    client.set_server_state(state);
  },
  
  /**
   *  Is received after the client has sent a CLIENT CONNET message. The message
   *  contains all data necessary to set up the game world.
   */
  [[SERVER + HANDSHAKE, Object, Array, Array], _], 
  function(world_data, players, entities, client) {
    var world = new World(world_data);

    client.set_world(world);

    for (var i = 0; i < players.length; i++) {
      process_game_message([[players[i].shift() + CONNECT].concat(players[i]), client]);
    }

    for (var i = 0; i < entities.length; i++) {
      process_game_message([[entities[i].shift() + SPAWN].concat(entities[i]), client]);
    }

    // client.server_state.no_players++
    client.set_state(CLIENT_CONNECTED);
  },
  
  [[SERVER + CONNECT, Number, Number, String, String], _],
  function(tick, id, name, color, client) {
    var player = new Player({
      id:     id,
      name:   name,
      color:  color
    });

    client.world.players[id] = player;
    client.server_state.no_players++;
    client.set_player(player);

    client.start_gameloop(tick);
  },
  
  /**
   *  Is recieved when disconnected from server.
   */
  [[SERVER + DISCONNECT, String], _], 
  function(reason, client) {
    client.disconnect_reason = reason;
  },
  
  function(msg) {
    console.log('Unhandled message')
    console.log(msg[0]);
  }
  
);

/**
 *  Processes game message recieved from server.
 *  
 */
var process_game_message = Match (

  /**
   * Is recived when a new player has connected to the server.
   */
  [[PLAYER + CONNECT, Number, String, String], _], 
  function(id, name, color, client) {
    var player = new Player({
      id:     id,
      name:   name,
      color:  color
    });
    client.world.players[player.id] = player;
    client.server_state.no_players++;
    client.log('Player "' + player.name + ' joined the world...');
  },

  /**
   * Is recived when the state of a player has changed
   */
  [[PLAYER + STATE, Number, Object], _],
  function(id, data, client) {
    var world = client.world,
        player = world.players[id],
        player_pos = client.server_state.no_players;
    if (player) {
      player.set_props(data);
      player.commit();
      for (var pid in world.players) {
        if (client.player.score > world.players[pid].score) {
          player_pos--;
        }
      }
      client.player.pos = player_pos;
      if (data.eid) {
        var entity = world.find(data.eid);
        player.entity = entity;
        if (player.is_me) {
          entity.is_me = true;
          client.respawn_at = 0;
          client.viewport.set_camera_pos(entity.pos);
        }
      }
    }
  },
  
  /**
   * Is recived when a new player ship is spawned
   */
  [[PLAYER + DESTROY, Number, Number, Number], _], 
  function(player_id, death_cause, killer_id, client) {
    var player  = client.world.players[player_id],
        killer  = client.world.players[killer_id],
        text    = '';
    
    if (player) {
      if (player.is_me) {
        if (death_cause == DEATH_CAUSE_KILLED) {
          text = 'You where killed by ' + killer.name;
        } else {
          text = 'You took your own life, you suck!';
        }
      } else {
        if (death_cause == DEATH_CAUSE_KILLED) {
          if (killer.is_me) {
            // This is a temporary solution to player score. When game rules are
            // in place, server will handle this.
            killer.s++;
          } 
          text = player.name + ' was killed by ' + (killer.is_me ? 'you' : killer.name) + '.';
        } else {
          text = player.name + ' killed him self.';
        }
      }
      client.log(text);      
    }
  },

  /**
   * Is recived when a player is ready
   */
  [[PLAYER + READY, Number], _], 
  function(player_id, client) {
    var player = client.world.players[player_id];
    client.log(player.is_me ? 'You are now ready' : 'Player "' + player.name + ' is ready');
    client.server_state.no_ready_players++;
  },
  
  /**
   * Is recived when a player has disconnected from the server.
   */
  [[PLAYER + DISCONNECT, Number, String], _], 
  function(player_id, reason, client) {
    var player = client.world.players[player_id];
    client.log('Player "' + player.name + ' disconnected. Reason: ' + reason);
    delete client.world.players[player_id];
    client.server_state.no_players--;
    if (client.world.round_state == 'waiting') {
      client.server_state.no_ready_players--;
    }
  },
  
  /**
   * Is recived when world state changes.
   */
  [[WORLD + STATE, Number, Number, Object], _], 
  function(state, timer, winners, client) {
    client.world.set_round_state(state, timer, winners);
    client.world.winners = null;
  },

  /**
   * Is recived when a ship has been created
   */
  [[SHIP + SPAWN, Number, Number, Array], _],
  function(id, pid, pos, client) {
    var player = client.world.players[pid];
    var entity = new Ship({
      id:   id,
      pid:  pid,
      pos:  pos
    });
    entity.is_me = player.is_me;
    player.entity = entity;
    entity.player = player
    client.world.append(entity);
  },

  /**
   * Is recived when a bullet has been created
   */
  [[BULLET + SPAWN, Number, Number, Array, Array, Number], _],
  function(id, oid, pos, vel, angle, client) {
    var entity = new Bullet({
      id:   id,
      oid:  oid,
      pos:  pos,
      vel:  vel,
      angle: angle
    });
    client.world.append(entity);
  },

  /**
   * Is recived when a bullet has been created
   */
  [[WALL + SPAWN, Number, Array, Array, String], _],
  function(id, pos, size, orientation, client) {
    var entity = new Wall({
      id:   id, 
      pos:  pos,
      size: size,
      o:    orientation      
    });
    client.world.append(entity);
  },
  
  /**
   * Is recived when an entity is destroyed
   */
  [[ENTITY + DESTROY, Number], _],
  function(entity_id,  client) {
    var entity = client.world.find(entity_id);
    entity.destroy();
  },

  /**
   * Is recived when an entity's state has changed.
   */
  [[SHIP + STATE, Number, Number, Number, Array, Array], _],
  function(id, angle, commands, pos, vel, client) {
    var entity = client.world.find(id);
    if (entity) {
      entity.angle    = angle;
      entity.commands = commands
      entity.pos      = pos;
      entity.vel      = vel;
    } 
  },

  //
  //  Default message handler.
  //
  //  The message sent by server could not be matched.
  //
  function(msg) {
    console.log('Unhandled message')
    console.log(msg[0]);
  }
  
);

Player.prototype.on_before_init = function() {
  this.pos = 1;
  this.is_me = false;
  this.winners = null;
}

/**
 *  Method World.draw
 *  Draw all entites within viewport bounds.
 */
World.prototype.draw = function(viewport, alpha) {
  var entities  = this.entities, 
      ctx       = viewport.ctx,
      camera    = viewport.camera;
  this.draw_grid(ctx, camera);
  for (var id in entities) {
    var entity = entities[id];
    if (!entity.is_me && intersects(entity.get_bounds(), viewport.get_camera_box())) {
      var point = viewport.translate(entity.pos);
      ctx.save();
      ctx.translate(point[0], point[1]);
      entity.draw(ctx);
      ctx.restore();
    }
  }
}

/**
 *  Draw's the background grid of the viewport.
 */
World.prototype.draw_grid = function(ctx, camera) {
  var x, y;
  var camx = camera.pos[0];
  var camy = camera.pos[1];
  var camw = camera.size[0];
  var camh = camera.size[1];
  ctx.save();
  ctx.fillStyle = 'black';
  ctx.strokeStyle = GRID_CELL_COLOR;
  ctx.lineWidth = 0.5;
  ctx.beginPath();

  if (camx < 0) {
    x = -camx;
  } else {
    x = GRID_CELL_SIZE - camx % GRID_CELL_SIZE;
  }

  while(x < camw) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, camh);
    x += GRID_CELL_SIZE;
  }

  if (camy < 0) {
    y = -camy;
  } else {
    y = GRID_CELL_SIZE - camy % GRID_CELL_SIZE
  }

  while(y < camh) {
    ctx.moveTo(0, y);
    ctx.lineTo(camw, y);
    y += GRID_CELL_SIZE;
  }
   
  ctx.stroke();

  // Left Edge
  if (camx < 0) {
    ctx.fillRect(0, 0, -camx, camh);
  }

  // Right Edge
  if (camx + camw > this.size[0]) {
    ctx.fillRect(this.size[0] - camx, 0, camx + camw - this.size[0], camh);
  }

  // Top Edge
  if (camy < 0) {
    ctx.fillRect(0, 0, camw, -camy);
  }

  // Bottom Edge
  if (camy + camh > this.size[1]) {
    ctx.fillRect(0, this.size[1] - camy, camw, camy - camh + this.size[1]);
  }
  ctx.restore();
}

/**
 *  Class Ship
 *  Local constructor for the Entity class. Add a visible property that 
 *  indiciates that the Entity is visible or not.
 */
Ship.prototype.on_before_init = function() {
  this.visible = true;
  this.spawning = true;
  this.is_me = false;
  this.player = null;
}

Ship.prototype.on_after_init = function() {
  var self = this;
  this.animations = {
    'plight': new PositionLightAnimation(this),
    'thrust': new ThrustAnimation(),
    'shield': new ShieldAnimation(),
    'spawn':  new SpawnAnimation(function() {
                self.spawning = false;
                delete self.animations['spawn']
              }),
    'die':    new DieAnimation(function() {
                self.destroyed = true;
                delete self.animations['die']
              }),
  }
}

/**
 *  Prepare properties for a draw call
 */
Ship.prototype.update = function(t, dt) {
  this.animations['shield'].set_active(this.is(SHIELD));
  this.animations['thrust'].set_active(this.is(THRUST));
  for (var anim in this.animations) {
    this.animations[anim].update(t, dt);
  }
}

/**
 *  Override the EntityBase.destroy method.
 */
Ship.prototype.destroy = function() {
  this.dead = true;
  this.animations['die'].set_active(true);
}

/**
 *  Method Ship.draw
 *  Draws the Ship instance on the specified GraphicsContext.
 */
Ship.prototype.draw = function(ctx) {
  var centerx = this.size[0] / 2,
      centery = this.size[1] / 2;
  if (!this.spawning && !this.dead) {
    ctx.rotate(this.angle);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.moveTo(0, -centery);
    ctx.lineTo(centerx, centery);
    ctx.lineTo(-centerx, centery);
    ctx.lineTo(0, -centery);
    ctx.fill();
  }
  for (var anim in this.animations) {
    ctx.save();
    this.animations[anim].draw(ctx);
    ctx.restore();
  }
  if(!this.is_me){  
    ctx.rotate(-this.angle);
    ctx.font = SHIP_FONT;
  	ctx.fillStyle = 'rgb(' + this.player.color + ')';
    draw_label(ctx, 0, this.size[1] + 10, this.player.name, 'center', 100);	
  }
}

/**
 *  Class Bullet
 *  Local constructor for the Entity class. Add a visible property that 
 *  indiciates that the Entity is visible or not.
 */
Bullet.prototype.on_before_init = function() {
  this.visible = true;
}

/**
 *  Method Ship.draw
 *  Draws the Bullet instance on the specified GraphicsContext.
 */
Bullet.prototype.draw = function(ctx) {
  var w = this.size[0],
      h = this.size[1];
  ctx.rotate(this.angle);
  ctx.fillStyle = "white";
  ctx.fillRect(-(w / 2), -(h / 2), w, h);
}

/**
 *  Method Wall.draw
 *  Draws Wall instance on the specified GraphicsContext.
 */
Wall.prototype.draw = function(ctx, world) {
  var w = this.size[0],
      h = this.size[1],
      t = Math.min(w, h) * 0.2,
      o = Math.min(w, h) * 0.8;
  ctx.save();
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "red";
  switch (this.o) {
    case 'n':
      ctx.fillRect(o, h - t, w - o * 2, t);
      break;
    case 'e':
      ctx.fillRect(0, o, t, h - o * 2);
      break;
    case 's':
      ctx.fillRect(o, 0, w - o * 2, t);
      break;
    case 'w':
      ctx.fillRect(w - t, o, t, h - o * 2);
      break;
  }
  ctx.restore();
}

/**
 *  Creates a new instance of the ThrustAnimation class.
 */
function ThrustAnimation() {
  var particles = new cParticleSystem();
  particles.active = false;
  particles.position = Vector.create(0, 12);	
  particles.positionRandom = Vector.create( 0, 0 );
  particles.gravity = Vector.create( 0.4, 0.2 );
  particles.speed = 2;
  particles.lifeSpan = 15;
  particles.lifeSpan = 9;
  particles.size = 2;
  particles.sizeRandom = 1;
  particles.angle = 120;
  particles.angleRandom = 15;
  particles.maxParticles = 120;
  particles.init();
  this.particles = particles; 
}

/**
 *  Sets if the animation should be active or not
 *  @param {Boolean} active True if the animation should be active else false
 *  @return {undefined} Nothing
 */
ThrustAnimation.prototype.set_active = function(active) {
  this.particles.active = active;
}

/**
 *  Updates the ThrustAnimation instance.
 *  @param {Number} t Current world time.
 *  @param {Number} dt Current delta time,
 *  @return {undefined} Nothing
 */
ThrustAnimation.prototype.update = function(t, dt) {
  this.particles.update(65 * dt);
}

/**
 *  Draws the ThrustAnimation instance on specified context.
 *  @param {Context2D} ctx The context to draw on.
 *  @return {undefined} Nothing
 */
ThrustAnimation.prototype.draw = function(ctx) {
  this.particles.render(ctx);
}

/**
 *  Creates a new instance of the ShieldAnimation class.
 */
function ShieldAnimation() {
  this.active = false;
  this.value = 0;
}

/**
 *  Sets if the animation should be active or not
 *  @param {Boolean} active True if the animation should be active else false
 *  @return {undefined} Nothing
 */
ShieldAnimation.prototype.set_active = function(active) {
  this.active = active;
  if (this.active) {
    this.value = 0.01;
  } 
}

/**
 *  Updates the ShieldAnimation instance.
 *  @param {Number} t Current world time.
 *  @param {Number} dt Current delta time,
 *  @return {undefined} Nothing
 */
ShieldAnimation.prototype.update = function(t, dt) {
  if (this.value > 0) {
    var value = this.active ? this.value + dt * 4 : this.value - dt * 4;
    if (value > 1) {
      value = 1;
    }
    this.value = value;
  }
}

/**
 *  Draws the ShieldAnimation instance on specified context.
 *  @param {Context2D} ctx The context to draw on.
 *  @return {undefined} Nothing
 */
ShieldAnimation.prototype.draw = function(ctx) {
  if (this.value > 0) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255,' + this.value + ')';    
    ctx.arc(0, 0, 20, 0, Math.PI / 180, true);
    ctx.stroke();
  }
}

/**
 *  Creates a new instance of the PositionLightAnimation class.
 */
function PositionLightAnimation(origin) {
  this.active = true;
  this.x = origin.size[0] / 2;
  this.y = origin.size[1] / 2;
  this.origin = origin;
  this.value = 0;
}

/**
 *  Sets if the animation should be active or not
 *  @param {Boolean} active True if the animation should be active else false
 *  @return {undefined} Nothing
 */
PositionLightAnimation.prototype.set_active = function(active) {
  this.active = active;
}

/**
 *  Updates the PositionLightAnimation instance.
 *  @param {Number} t Current world time.
 *  @param {Number} dt Current delta time,
 *  @return {undefined} Nothing
 */
PositionLightAnimation.prototype.update = function(t, dt) {
  this.value += dt * 4;
}

/**
 *  Draws the PositionLightAnimation instance on specified context.
 *  @param {Context2D} ctx The context to draw on.
 *  @return {undefined} Nothing
 */
PositionLightAnimation.prototype.draw = function(ctx) {
  if (!this.origin.dead && !this.origin.spawning) {
    var alpha = Math.abs(Math.sin((this.value)));
    if (alpha < 0.3) alpha = 0.3;   
    ctx.beginPath();
    ctx.fillStyle = 'rgba(' + this.origin.player.color + ',' + alpha +')';
    ctx.arc(this.x, this.y, 1, 0, 2 * Math.PI, true);
    ctx.fill();
  }
}

/**
 *  Creates a new instance of the SpawnAnimation class.
 */
function SpawnAnimation(callback) {
  var particles = new cParticleSystem();
  particles.active = true;
  particles.position = Vector.create( 0, 0 );
  particles.positionRandom = Vector.create( 3, 3 );
  particles.startColour = [ 123, 180, 255, 1 ];
  particles.finishColour = [59,116,191, 0 ];
  particles.startColourRandom = [80,20,20,0 ];
  particles.finishColourRandom = [60,10,10,0.1];
  particles.size = 15;
  particles.sizeRandom = 3;
  particles.maxParticles = 100;
  particles.duration = 1;
  particles.gravity = Vector.create( 0.4, 0.2 );
  particles.lifeSpan = 7;
  particles.lifeSpanRandom = 0;
  particles.init();
  this.particles = particles;
  this.ondone = callback;
}

/**
 *  Updates the SpawnAnimation instance.
 *  @param {Number} t Current world time.
 *  @param {Number} dt Current delta time,
 *  @return {undefined} Nothing
 */
SpawnAnimation.prototype.update = function(t, dt) {
  this.particles.update(5 * dt);
  if (this.particles.particleCount == 0) {
    this.ondone();
  }
}

/**
 *  Draws the SpawnAnimation instance on specified context.
 *  @param {Context2D} ctx The context to draw on.
 *  @return {undefined} Nothing
 */
SpawnAnimation.prototype.draw = function(ctx) {
  this.particles.render(ctx);
}

/**
 *  Creates a new instance of the DieAnimation class.
 */
function DieAnimation(callback) {
  var particles = new cParticleSystem();
  particles.active = false;  
  particles.position = Vector.create( 0, 0 );
  particles.positionRandom = Vector.create( 0, 0 );
  particles.startColour = [ 255, 255, 255, 1 ];
  particles.finishColour = [0, 0, 0, 1 ];
  particles.startColourRandom = [0,0,0,0 ];
  particles.finishColourRandom = [0,0,0,0];
  particles.size = 3;
  particles.sizeRandom = 2;
  particles.angle = 0;
  particles.angleRandom = 360;
  particles.maxParticles = 200;
  particles.duration = 5;
  particles.lifeSpan = 4;
  particles.lifeSpanRandom = 2;
  particles.init();
  this.particles = particles;
  this.ondone = callback;
}

/**
 *  Sets if the animation should be active or not
 *  @param {Boolean} active True if the animation should be active else false
 *  @return {undefined} Nothing
 */
DieAnimation.prototype.set_active = function(active) {
  this.particles.active = active;
}

/**
 *  Updates the DieAnimation instance.
 *  @param {Number} t Current world time.
 *  @param {Number} dt Current delta time,
 *  @return {undefined} Nothing
 */
DieAnimation.prototype.update = function(t, dt) {
  if (this.particles.active) {
    this.particles.update(15 * dt);
    if (this.particles.elapsedTime == 0) {
      this.ondone();
    }
  }
}

/**
 *  Draws the DieAnimation instance on specified context.
 *  @param {Context2D} ctx The context to draw on.
 *  @return {undefined} Nothing
 */
DieAnimation.prototype.draw = function(ctx) {
  if (this.particles.active) {
    this.particles.render(ctx);
  }
}

/**
 *  Draws a vertical bar 
 *  
 */
function draw_v_bar(ctx, x, y, w, h, percent) {
  ctx.lineWidth = 0.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fillRect(x + 2, (y + 2) + ((h - 4) - (h - 4) * (percent / 100)), (w - 4) , (h - 4) * (percent / 100));
  ctx.stroke();   
}

/**
 *  Draws a label
 *  
 */
function draw_label(ctx, x, y, text, align, width) {
  ctx.textAlign = align || 'left';
  ctx.fillText(text, x, y, width || 0);
}

/**
 *  Returns current time stamp
 */
function get_time() {
  return new Date().getTime();
}

/**
 *  Returns a number with specified decimals
 *  @param {Number} value The number to round
 *  @param {Number} decimals The no of deciamls.
 *  @return {Number} A rounded number.
 */
function round_number(value, decimals) {
	return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
