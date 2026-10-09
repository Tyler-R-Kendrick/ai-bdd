using Reqnroll.Bindings;
using Reqnroll.BoDi;
using Reqnroll.Infrastructure;
using Reqnroll.Plugins;
using Reqnroll.UnitTestProvider;

[assembly: RuntimePlugin(typeof(AiBdd.Reqnroll.AiBddRuntimePlugin))]

namespace AiBdd.Reqnroll;

/// <summary>
/// The Reqnroll runtime plugin. Listing it in <c>reqnroll.json</c> is the whole
/// installation:
///
/// <code>
/// {
///   "runtime": { "plugins": [ { "type": "AiBdd.Reqnroll.AiBddRuntimePlugin, AiBdd.Reqnroll" } ] }
/// }
/// </code>
///
/// It replaces <see cref="IStepDefinitionMatchService"/> with a decorator that falls
/// back to the ai-bdd daemon. The registration point is verified by reflection against
/// Reqnroll 2.4 (VERIFY V13): <c>RuntimePluginEvents.RegisterGlobalDependencies</c>
/// hands over the <c>ObjectContainer</c>; the
/// <c>CustomizeGlobalDependencies</c> event only carries the configuration, so the
/// container is not reachable from there. The existing registration is resolved
/// *before* it is replaced, which is what makes the decorator possible with BoDi.
/// </summary>
public sealed class AiBddRuntimePlugin : IRuntimePlugin
{
    /// <inheritdoc />
    public void Initialize(
        RuntimePluginEvents runtimePluginEvents,
        RuntimePluginParameters runtimePluginParameters,
        UnitTestProviderConfiguration unitTestProviderConfiguration)
    {
        _ = runtimePluginParameters;
        _ = unitTestProviderConfiguration;
        runtimePluginEvents.RegisterGlobalDependencies += (_, eventArgs) =>
        {
            var container = eventArgs.ObjectContainer;
            var runtime = new AiBddRuntime();
            container.RegisterInstanceAs(runtime);
            IStepDefinitionMatchService? inner = null;
            if (container.IsRegistered(typeof(IStepDefinitionMatchService)))
            {
                // Resolve before replacing, otherwise the decorator would resolve
                // itself. BoDi replaces a registration in place.
                inner = container.Resolve<IStepDefinitionMatchService>();
            }

            container.RegisterInstanceAs<IStepDefinitionMatchService>(
                new AiBddStepDefinitionMatchService(inner, runtime));
        };
    }
}
