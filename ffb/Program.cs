// Brake Trainer — force feedback probe
//
// Step one of giving the trainer force feedback. This does not talk to the
// browser yet. It answers the questions that have to be answered before any
// of that is worth building:
//
//   1. Which devices on this rig can actually accept force feedback?
//   2. Can we take one and make it push back?
//   3. Does holding the wheel for force feedback stop the browser reading it?
//
// DirectInput requires EXCLUSIVE access to send forces, and that is the part
// most likely to bite: if Chrome loses the wheel while this is running, the
// trainer has to read the wheel through this program instead of through the
// browser. Question 3 is the one to watch, and it is why this exists as its
// own tool rather than as a feature hidden inside the app.
//
// Safety: a direct drive wheel can hurt you. Forces start at 20% and the
// program releases the device on every exit path.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using SharpDX.DirectInput;

internal static class Program
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    private const int MaxMagnitude = 10000;   // DirectInput's full scale
    private static int _gainPercent = 20;     // deliberately gentle to begin with

    private static Joystick? _device;
    private static Effect? _constant;
    private static Effect? _spring;

    private static int Main()
    {
        Console.Title = "Brake Trainer — force feedback probe";
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Release();
        Console.CancelKeyPress += (_, e) => { Release(); e.Cancel = false; };

        try
        {
            return Run();
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("Stopped with an error:");
            Console.WriteLine("  " + ex.Message);
            Console.WriteLine();
            Console.WriteLine("Copy this whole window and send it back.");
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
        finally
        {
            Release();
        }
    }

    private static int Run()
    {
        using var input = new DirectInput();

        var all = input.GetDevices(DeviceClass.GameControl, DeviceEnumerationFlags.AttachedOnly)
                       .ToList();
        var forceCapable = input.GetDevices(DeviceClass.GameControl, DeviceEnumerationFlags.ForceFeedback)
                                .Select(d => d.InstanceGuid)
                                .ToHashSet();

        Console.WriteLine("Controllers attached to this rig");
        Console.WriteLine("--------------------------------");
        if (all.Count == 0)
        {
            Console.WriteLine("  none found.");
            Console.WriteLine();
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 1;
        }

        for (var i = 0; i < all.Count; i++)
        {
            var d = all[i];
            var ffb = forceCapable.Contains(d.InstanceGuid) ? "force feedback" : "input only";
            Console.WriteLine($"  [{i}] {d.InstanceName}  ({ffb})");
        }

        var candidates = all.Where(d => forceCapable.Contains(d.InstanceGuid)).ToList();
        Console.WriteLine();
        if (candidates.Count == 0)
        {
            Console.WriteLine("None of these report force feedback support.");
            Console.WriteLine("That is the answer to question 1, and it is worth knowing.");
            Console.WriteLine();
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 2;
        }

        Console.Write($"Which device should push back? Enter its number: ");
        var line = Console.ReadLine();
        if (!int.TryParse(line, out var pick) || pick < 0 || pick >= all.Count)
        {
            Console.WriteLine("Not a listed number. Nothing was touched.");
            return 1;
        }

        var chosen = all[pick];
        if (!forceCapable.Contains(chosen.InstanceGuid))
        {
            Console.WriteLine($"{chosen.InstanceName} is input only — it cannot take forces.");
            return 2;
        }

        Console.WriteLine();
        Console.WriteLine($"Opening {chosen.InstanceName}…");

        _device = new Joystick(input, chosen.InstanceGuid);

        // Forces need exclusive access. Background means it keeps working when
        // this window is not focused — which is the whole point, since the
        // trainer will be in front.
        _device.SetCooperativeLevel(GetConsoleWindow(),
            CooperativeLevel.Exclusive | CooperativeLevel.Background);

        // The wheel's own centring spring fights anything we send, so off it goes.
        try { _device.Properties.AutoCenter = false; }
        catch { Console.WriteLine("  (could not switch off the built-in centring spring)"); }

        _device.Acquire();
        Console.WriteLine("  acquired.");

        var axes = _device.GetObjects(DeviceObjectTypeFlags.Axis)
                          .OrderBy(o => o.Offset)
                          .ToList();
        if (axes.Count == 0)
        {
            Console.WriteLine("No axes reported — cannot aim a force.");
            return 2;
        }
        var steerOffset = (int)axes[0].Offset;   // X is the steering axis on a wheel
        Console.WriteLine($"  steering axis: {axes[0].Name}");

        var effects = _device.GetEffects().Select(e => e.Name).ToList();
        Console.WriteLine($"  effects offered: {string.Join(", ", effects)}");
        Console.WriteLine();

        PrintKeys();

        var running = true;
        var springOn = false;
        var force = 0;      // -100..100, as a percentage of full scale

        while (running)
        {
            if (Console.KeyAvailable)
            {
                var key = Console.ReadKey(true).Key;
                switch (key)
                {
                    case ConsoleKey.LeftArrow:  force = Math.Max(-100, force - 10); ApplyConstant(steerOffset, force); break;
                    case ConsoleKey.RightArrow: force = Math.Min(100, force + 10); ApplyConstant(steerOffset, force); break;
                    case ConsoleKey.UpArrow:    _gainPercent = Math.Min(100, _gainPercent + 5); ApplyConstant(steerOffset, force); break;
                    case ConsoleKey.DownArrow:  _gainPercent = Math.Max(0, _gainPercent - 5); ApplyConstant(steerOffset, force); break;
                    case ConsoleKey.Spacebar:   force = 0; springOn = false; StopAll(); break;
                    case ConsoleKey.S:          springOn = !springOn; ToggleSpring(steerOffset, springOn); break;
                    case ConsoleKey.Q:          running = false; break;
                }
            }

            // Reading the device here is also the test for question 3: if the
            // browser can still see this wheel while these numbers move, the
            // trainer can keep using the Gamepad API.
            try
            {
                _device.Poll();
                var state = _device.GetCurrentState();
                var raw = state.X;                      // 0..65535, centre ~32767
                var norm = (raw - 32767.5) / 32767.5;   // -1..1
                Console.Write($"\r  steering {norm,7:F3}   force {force,4}%   gain {_gainPercent,3}%   " +
                              $"spring {(springOn ? "on " : "off")}        ");
            }
            catch (SharpDX.SharpDXException)
            {
                // Lost the device (alt-tab, unplug). Take it back and carry on.
                try { _device.Acquire(); } catch { /* keep trying next tick */ }
            }

            Thread.Sleep(16);
        }

        Console.WriteLine();
        Console.WriteLine();
        Console.WriteLine("Releasing the wheel…");
        Release();
        Console.WriteLine("Done. Send back what you felt and what the numbers did.");
        Console.WriteLine("Press Enter to close.");
        Console.ReadLine();
        return 0;
    }

    private static void PrintKeys()
    {
        Console.WriteLine("Keys");
        Console.WriteLine("  left / right   push the wheel that way, 10% a press");
        Console.WriteLine("  up / down      overall strength (starts at 20%)");
        Console.WriteLine("  S              centring spring on/off");
        Console.WriteLine("  space          stop all forces");
        Console.WriteLine("  Q              release the wheel and quit");
        Console.WriteLine();
        Console.WriteLine("Start gentle. Hold the rim before pressing anything.");
        Console.WriteLine();
    }

    private static EffectParameters BaseParams(int axisOffset) => new()
    {
        Flags = EffectFlags.ObjectOffsets | EffectFlags.Cartesian,
        Duration = int.MaxValue,
        SamplePeriod = 0,
        Gain = Math.Clamp(_gainPercent, 0, 100) * 100,   // 0..10000
        TriggerButton = -1,
        TriggerRepeatInterval = int.MaxValue,
        Axes = new[] { axisOffset },
        Directions = new[] { 0 },
        StartDelay = 0,
    };

    private static void ApplyConstant(int axisOffset, int percent)
    {
        if (_device == null) return;
        var magnitude = Math.Clamp(percent, -100, 100) * (MaxMagnitude / 100);

        var p = BaseParams(axisOffset);
        p.Parameters = new ConstantForce { Magnitude = magnitude };

        try
        {
            if (_constant == null)
            {
                _constant = new Effect(_device, EffectGuid.ConstantForce, p);
                _constant.Start();
            }
            else
            {
                _constant.SetParameters(p, EffectParameterFlags.Direction
                                         | EffectParameterFlags.Gain
                                         | EffectParameterFlags.TypeSpecificParameters
                                         | EffectParameterFlags.Start);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("  constant force refused: " + ex.Message);
        }
    }

    private static void ToggleSpring(int axisOffset, bool on)
    {
        if (_device == null) return;
        try
        {
            if (!on)
            {
                _spring?.Stop();
                return;
            }
            var p = BaseParams(axisOffset);
            p.Parameters = new ConditionSet
            {
                Conditions = new[]
                {
                    new Condition
                    {
                        Offset = 0,
                        PositiveCoefficient = 5000,
                        NegativeCoefficient = 5000,
                        PositiveSaturation = MaxMagnitude,
                        NegativeSaturation = MaxMagnitude,
                        DeadBand = 0,
                    }
                }
            };
            if (_spring == null) _spring = new Effect(_device, EffectGuid.Spring, p);
            else _spring.SetParameters(p, EffectParameterFlags.TypeSpecificParameters | EffectParameterFlags.Gain);
            _spring.Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("  spring refused: " + ex.Message);
        }
    }

    private static void StopAll()
    {
        try { _constant?.Stop(); } catch { }
        try { _spring?.Stop(); } catch { }
    }

    private static void Release()
    {
        StopAll();
        try { _constant?.Dispose(); } catch { }
        try { _spring?.Dispose(); } catch { }
        _constant = null; _spring = null;
        try
        {
            if (_device != null)
            {
                try { _device.Properties.AutoCenter = true; } catch { }
                _device.Unacquire();
                _device.Dispose();
            }
        }
        catch { }
        _device = null;
    }
}
